package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/sshconfig"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) OpenNewWindow() error {
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	cmd := exec.Command(exe)
	if e = cmd.Start(); e != nil {
		return e
	}
	go cmd.Wait()
	return nil
}
func (a *App) OpenExternal(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || !(u.Scheme == "https" || u.Scheme == "http" || u.Scheme == "mailto") {
		return fmt.Errorf("unsupported external URL")
	}
	runtime.BrowserOpenURL(a.ctx, raw)
	return nil
}
func (a *App) ReadClipboardText() (string, error)   { return runtime.ClipboardGetText(a.ctx) }
func (a *App) WriteClipboardText(text string) error { return runtime.ClipboardSetText(a.ctx, text) }

type ImportResult struct {
	Imported   int    `json:"imported"`
	Skipped    int    `json:"skipped"`
	SourcePath string `json:"sourcePath"`
}

func (a *App) ImportSshConfig() (ImportResult, error) {
	if a.store == nil {
		return ImportResult{}, fmt.Errorf("saved-connections store unavailable")
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return ImportResult{}, e
	}
	p, e := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Import SSH config", DefaultDirectory: filepath.Join(home, ".ssh"), DefaultFilename: "config"})
	if e != nil || p == "" {
		return ImportResult{}, e
	}
	data, e := os.ReadFile(p)
	if e != nil {
		return ImportResult{}, e
	}
	username := os.Getenv("USER")
	if u, e := user.Current(); e == nil {
		username = u.Username
	}
	result := ImportResult{SourcePath: p}
	existing, e := a.store.List()
	if e != nil {
		return result, e
	}
	ids := map[string]bool{}
	for _, v := range existing {
		ids[v.ID] = true
	}
	for _, v := range sshconfig.Parse(string(data), username, home) {
		input := ConnectInput{Host: v.Host, Port: v.Port, Username: v.Username, AuthMethod: v.AuthMethod, Password: v.Password, PrivateKeyPath: v.PrivateKeyPath, AgentSocket: os.Getenv("SSH_AUTH_SOCK"), HostVerification: v.HostVerification, KnownHostsPath: v.KnownHostsPath}
		if v.JumpHost != nil {
			j := v.JumpHost
			input.JumpHost = &JumpHostInput{Host: j.Host, Port: j.Port, Username: j.Username, AuthMethod: j.AuthMethod, AgentSocket: os.Getenv("SSH_AUTH_SOCK")}
		}
		id := a.store.GetConnectionID(input.Host, input.Port, input.Username)
		if ids[id] {
			result.Skipped++
			continue
		}
		s, e := a.store.Save(toStoreConnectInput(input))
		if e != nil {
			return result, e
		}
		if e = a.store.Rename(s.ID, v.DisplayName); e != nil {
			return result, e
		}
		ids[id] = true
		result.Imported++
	}
	return result, nil
}

type TailscaleHost struct {
	ID          string `json:"id"`
	Host        string `json:"host"`
	DisplayName string `json:"displayName"`
	DNSName     string `json:"dnsName,omitempty"`
	IP          string `json:"ip,omitempty"`
	OS          string `json:"os,omitempty"`
	Online      bool   `json:"online"`
	Active      bool   `json:"active"`
	SSHUser     string `json:"sshUser,omitempty"`
}

func (a *App) ListTailscaleHosts() ([]TailscaleHost, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	data, e := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	if e != nil {
		return nil, fmt.Errorf("tailscale status: %w", e)
	}
	var status struct {
		Peer map[string]struct {
			ID           string
			HostName     string
			DNSName      string
			TailscaleIPs []string
			OS           string
			Online       bool
			Active       bool
		}
	}
	if e = json.Unmarshal(data, &status); e != nil {
		return nil, e
	}
	out := make([]TailscaleHost, 0, len(status.Peer))
	for key, p := range status.Peer {
		ip := ""
		if len(p.TailscaleIPs) > 0 {
			ip = p.TailscaleIPs[0]
		}
		host := strings.TrimSuffix(p.DNSName, ".")
		if host == "" {
			host = ip
		}
		id := p.ID
		if id == "" {
			id = key
		}
		out = append(out, TailscaleHost{ID: id, Host: host, DisplayName: p.HostName, DNSName: p.DNSName, IP: ip, OS: p.OS, Online: p.Online, Active: p.Active})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out, nil
}
