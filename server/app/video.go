package app

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"sync/atomic"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/vision"
	"golang.org/x/crypto/ssh"
)

type videoStream struct {
	session *ssh.Session
	stopped atomic.Bool
}
type VideoInput struct {
	Display string `json:"display"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	FPS     int    `json:"fps"`
	Quality int    `json:"quality"`
}

func (a *App) EnableVisionMode(id, display string) (map[string]string, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return nil, e
	}
	result, e := vision.EnsureVirtualDisplay(vision.ExecFunc(remoteExec(s)), display)
	if e != nil {
		return nil, e
	}
	services, e := a.getServices(id)
	if e != nil {
		return nil, e
	}
	services.mu.Lock()
	services.display = result.Display
	services.mu.Unlock()
	a.terminals.SetDisplay(result.Display)
	return map[string]string{"display": result.Display}, nil
}
func (a *App) DisableVisionMode(id string) error {
	s, e := a.getServices(id)
	if e != nil {
		return nil
	}
	s.mu.Lock()
	s.display = ""
	for key, v := range s.videos {
		v.stopped.Store(true)
		v.session.Close()
		delete(s.videos, key)
	}
	s.mu.Unlock()
	a.terminals.SetDisplay("")
	return nil
}
func (a *App) StartVideoStream(id string, input VideoInput) (map[string]string, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return nil, e
	}
	services, e := a.getServices(id)
	if e != nil {
		return nil, e
	}
	binary, e := vision.ResolveFfmpegPath(vision.ExecFunc(remoteExec(s)))
	if e != nil {
		return nil, e
	}
	ch, e := s.Client().NewSession()
	if e != nil {
		return nil, e
	}
	out, e := ch.StdoutPipe()
	if e != nil {
		ch.Close()
		return nil, e
	}
	var stderr bytes.Buffer
	ch.Stderr = &stderr
	command := vision.BuildFfmpegCommand(binary, input.Display, vision.StreamOptions{Width: input.Width, Height: input.Height, FPS: input.FPS, Quality: input.Quality})
	if e = ch.Start(command); e != nil {
		ch.Close()
		return nil, e
	}
	streamID := newID()
	v := &videoStream{session: ch}
	services.mu.Lock()
	services.videos[streamID] = v
	services.mu.Unlock()
	a.emit("video:state", map[string]string{"streamId": streamID, "status": "running"})
	go func() {
		defer ch.Close()
		readErr := vision.DemuxMJPEG(out, func(frame []byte, seq int) {
			a.emit("video:frame", map[string]any{"streamId": streamID, "data": base64.StdEncoding.EncodeToString(frame), "seq": seq})
		})
		waitErr := ch.Wait()
		status := "stopped"
		message := ""
		if !v.stopped.Load() {
			if readErr != nil {
				status = "error"
				message = readErr.Error()
			} else if waitErr != nil {
				status = "error"
				message = fmt.Sprintf("%v: %s", waitErr, stderr.String())
			}
		}
		services.mu.Lock()
		delete(services.videos, streamID)
		services.mu.Unlock()
		a.emit("video:state", map[string]string{"streamId": streamID, "status": status, "message": message})
	}()
	return map[string]string{"streamId": streamID}, nil
}
func (a *App) StopVideoStream(id, streamID string) error {
	s, e := a.getServices(id)
	if e != nil {
		return nil
	}
	s.mu.Lock()
	v := s.videos[streamID]
	delete(s.videos, streamID)
	s.mu.Unlock()
	if v != nil {
		v.stopped.Store(true)
		return v.session.Close()
	}
	return nil
}
