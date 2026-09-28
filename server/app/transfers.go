package app

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"time"

	fs "github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
)

func uploadConflicts(c fs.FileSystem, local, remote string, out *[]FileConflictItem) error {
	info, e := os.Stat(local)
	if e != nil {
		return e
	}
	target, e := c.Stat(remote)
	exists := e == nil
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if exists && (!info.IsDir() || !target.IsDir()) {
		kind := "file"
		if target.IsDir() {
			kind = "directory"
		}
		*out = append(*out, FileConflictItem{remote, kind})
		return nil
	}
	if !info.IsDir() || !exists {
		return nil
	}
	entries, e := os.ReadDir(local)
	if e != nil {
		return e
	}
	for _, v := range entries {
		if e = uploadConflicts(c, filepath.Join(local, v.Name()), path.Join(remote, v.Name()), out); e != nil {
			return e
		}
	}
	return nil
}
func downloadConflicts(c fs.FileSystem, remote, local string, out *[]FileConflictItem) error {
	info, e := c.Stat(remote)
	if e != nil {
		return e
	}
	target, e := os.Stat(local)
	exists := e == nil
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if exists && (!info.IsDir() || !target.IsDir()) {
		kind := "file"
		if target.IsDir() {
			kind = "directory"
		}
		*out = append(*out, FileConflictItem{local, kind})
		return nil
	}
	if !info.IsDir() || !exists {
		return nil
	}
	entries, e := c.ReadDir(remote)
	if e != nil {
		return e
	}
	for _, v := range entries {
		if fs.IsPartPath(v.Name()) {
			continue
		}
		if e = downloadConflicts(c, path.Join(remote, v.Name()), filepath.Join(local, v.Name()), out); e != nil {
			return e
		}
	}
	return nil
}
func validateStrategy(s string) error {
	if s != "" && s != "ask" && s != "skip" && s != "overwrite" {
		return fmt.Errorf("invalid conflict strategy")
	}
	return nil
}
func (a *App) UploadLocalEntries(id string, input UploadLocalEntriesInput) (FileOperationResult, error) {
	if e := validateStrategy(input.ConflictStrategy); e != nil {
		return FileOperationResult{}, e
	}
	c, e := a.sftpClient(id)
	if e != nil {
		return FileOperationResult{}, e
	}
	conflicts := []FileConflictItem{}
	for _, local := range input.LocalPaths {
		if e = uploadConflicts(c, local, path.Join(input.RemotePath, filepath.Base(local)), &conflicts); e != nil {
			return FileOperationResult{}, e
		}
	}
	if len(conflicts) > 0 && (input.ConflictStrategy == "" || input.ConflictStrategy == "ask") {
		return FileOperationResult{Status: "conflict", Conflicts: conflicts}, nil
	}
	total, e := fs.CountLocalItems(input.LocalPaths)
	if e != nil {
		return FileOperationResult{}, e
	}
	bytes, e := fs.CountLocalBytes(input.LocalPaths)
	if e != nil {
		return FileOperationResult{}, e
	}
	source := ""
	if len(input.LocalPaths) > 0 {
		source = input.LocalPaths[0]
	}
	return a.transfer(id, input.OperationID, "upload", source, input.RemotePath, total, bytes, input.ConflictStrategy, func(opts fs.TransferOptions) error {
		for _, local := range input.LocalPaths {
			info, e := os.Stat(local)
			if e != nil {
				return e
			}
			remote := path.Join(input.RemotePath, filepath.Base(local))
			if info.IsDir() {
				e = fs.UploadDirectory(c, local, remote, opts)
			} else {
				e = fs.UploadFile(c, local, remote, opts)
			}
			if e != nil {
				return e
			}
		}
		return nil
	})
}
func (a *App) DownloadEntry(id string, input DownloadRemoteEntryInput) (FileOperationResult, error) {
	if e := validateStrategy(input.ConflictStrategy); e != nil {
		return FileOperationResult{}, e
	}
	c, e := a.sftpClient(id)
	if e != nil {
		return FileOperationResult{}, e
	}
	conflicts := []FileConflictItem{}
	if e = downloadConflicts(c, input.RemotePath, input.LocalPath, &conflicts); e != nil {
		return FileOperationResult{}, e
	}
	if len(conflicts) > 0 && (input.ConflictStrategy == "" || input.ConflictStrategy == "ask") {
		return FileOperationResult{Status: "conflict", Conflicts: conflicts}, nil
	}
	info, e := c.Stat(input.RemotePath)
	if e != nil {
		return FileOperationResult{}, e
	}
	return a.transfer(id, input.OperationID, "download", input.RemotePath, input.LocalPath, 1, info.Size(), input.ConflictStrategy, func(opts fs.TransferOptions) error {
		if info.IsDir() {
			return fs.DownloadDirectory(c, input.RemotePath, input.LocalPath, opts)
		}
		return fs.DownloadFile(c, input.RemotePath, input.LocalPath, opts)
	})
}
func (a *App) transfer(id, operationID, kind, source, target string, total int, bytes int64, strategy string, run func(fs.TransferOptions) error) (FileOperationResult, error) {
	if operationID == "" {
		operationID = newID()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.registerCancel(operationID, cancel)
	defer a.unregisterCancel(operationID)
	services, e := a.getServices(id)
	if e != nil {
		return FileOperationResult{}, e
	}
	done := services.idle.Governor().BeginForeground()
	defer done()
	rate := fs.NewRateEstimator()
	var transferred int64
	skipped := 0
	event := FileOperationEvent{OperationID: operationID, Kind: kind, Status: "running", SourcePath: source, TargetPath: target, Message: "Transferring " + source, TotalItems: total, Transport: "sftp"}
	emitter := fs.NewThrottledEmitter(func() {
		n := transferred
		event.TransferredBytes = &n
		event.TotalBytes = &bytes
		bps, _ := rate.BytesPerSecond()
		event.BytesPerSecond = &bps
		eta, _ := rate.EtaSeconds(n, bytes)
		event.EtaSeconds = &eta
		a.emitFileOperationEvent(event)
	})
	a.emitFileOperationEvent(event)
	e = run(fs.TransferOptions{Ctx: ctx, SkipExisting: strategy == "skip", OnSkip: func() { skipped++ }, OnProgress: func(p string, n int64) {
		transferred += n
		rate.Record(transferred, time.Now())
		event.CurrentPath = p
		emitter.MaybeEmit(false)
	}})
	if e != nil {
		event.Status = "failed"
		if fs.IsCanceled(e) || ctx.Err() != nil {
			event.Status = "canceled"
		}
		event.Error = e.Error()
		event.Message = event.Status + ": " + source
		event.Retryable = true
		a.emitFileOperationEvent(event)
		return FileOperationResult{}, e
	}
	event.Status = "completed"
	event.CompletedItems = total
	event.SkippedItems = skipped
	event.Message = "Completed " + source
	emitter.MaybeEmit(true)
	return FileOperationResult{Status: "completed", SkippedItems: skipped}, nil
}
