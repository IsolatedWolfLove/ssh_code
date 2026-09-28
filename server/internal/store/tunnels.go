package store

import (
	"encoding/json"
	"fmt"
	"strings"
)

// TunnelKind mirrors contracts.ts's TunnelKind.
type TunnelKind string

const (
	TunnelKindLocal   TunnelKind = "local"
	TunnelKindRemote  TunnelKind = "remote"
	TunnelKindDynamic TunnelKind = "dynamic"
)

// SavedTunnelConfig mirrors contracts.ts's SavedTunnelConfig discriminated
// union (SavedLocalTunnelConfig | SavedRemoteTunnelConfig |
// SavedDynamicTunnelConfig). Represented here as one flat struct with all
// variants' fields, discriminated by Kind, rather than three separate Go
// types: this keeps JSON marshal/unmarshal trivial (a plain struct tag set)
// while still round-tripping the exact field set contracts.ts expects per
// kind - fields that don't apply to a given Kind are simply omitted from
// the JSON via `omitempty` and left at their zero value in Go.
type SavedTunnelConfig struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Kind TunnelKind `json:"kind"`

	// local + remote
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`

	// local + dynamic
	LocalHost string `json:"localHost,omitempty"`
	LocalPort int    `json:"localPort,omitempty"`

	// remote only
	RemoteHost string `json:"remoteHost,omitempty"`
	RemotePort int    `json:"remotePort,omitempty"`
}

// isValidTunnelConfig mirrors isSavedTunnelConfig in saved-connections.ts:
// structural validation per kind (required fields present and port-shaped).
func isValidTunnelConfig(t SavedTunnelConfig) bool {
	if strings.TrimSpace(t.ID) == "" || strings.TrimSpace(t.Name) == "" {
		return false
	}

	switch t.Kind {
	case TunnelKindDynamic:
		return strings.TrimSpace(t.LocalHost) != "" && isValidPort(t.LocalPort)
	case TunnelKindLocal:
		return strings.TrimSpace(t.LocalHost) != "" && isValidPort(t.LocalPort) &&
			strings.TrimSpace(t.TargetHost) != "" && isValidPort(t.TargetPort)
	case TunnelKindRemote:
		return strings.TrimSpace(t.RemoteHost) != "" && isValidPort(t.RemotePort) &&
			strings.TrimSpace(t.TargetHost) != "" && isValidPort(t.TargetPort)
	default:
		return false
	}
}

// normalizeTunnelConfig mirrors normalizeTunnelConfig in
// saved-connections.ts: trims id/name/hosts, validates ports, and returns
// (config, false) if the tunnel is structurally invalid (dropped rather than
// stored, same as the original).
func normalizeTunnelConfig(t SavedTunnelConfig) (SavedTunnelConfig, bool) {
	t.ID = strings.TrimSpace(t.ID)
	t.Name = strings.TrimSpace(t.Name)
	if t.ID == "" || t.Name == "" {
		return SavedTunnelConfig{}, false
	}

	switch t.Kind {
	case TunnelKindDynamic:
		t.LocalHost = strings.TrimSpace(t.LocalHost)
		if t.LocalHost == "" || !isValidPort(t.LocalPort) {
			return SavedTunnelConfig{}, false
		}
		return t, true

	case TunnelKindLocal:
		t.TargetHost = strings.TrimSpace(t.TargetHost)
		if t.TargetHost == "" || !isValidPort(t.TargetPort) {
			return SavedTunnelConfig{}, false
		}
		t.LocalHost = strings.TrimSpace(t.LocalHost)
		if t.LocalHost == "" || !isValidPort(t.LocalPort) {
			return SavedTunnelConfig{}, false
		}
		return t, true

	case TunnelKindRemote:
		t.TargetHost = strings.TrimSpace(t.TargetHost)
		if t.TargetHost == "" || !isValidPort(t.TargetPort) {
			return SavedTunnelConfig{}, false
		}
		t.RemoteHost = strings.TrimSpace(t.RemoteHost)
		if t.RemoteHost == "" || !isValidPort(t.RemotePort) {
			return SavedTunnelConfig{}, false
		}
		return t, true

	default:
		return SavedTunnelConfig{}, false
	}
}

// normalizeTunnels mirrors normalizeTunnels in saved-connections.ts: drops
// invalid entries, then dedupes by id (first occurrence wins).
func normalizeTunnels(tunnels []SavedTunnelConfig) []SavedTunnelConfig {
	seen := make(map[string]bool, len(tunnels))
	out := make([]SavedTunnelConfig, 0, len(tunnels))
	for _, t := range tunnels {
		next, ok := normalizeTunnelConfig(t)
		if !ok || seen[next.ID] {
			continue
		}
		seen[next.ID] = true
		out = append(out, next)
	}
	return out
}

// parseLegacyTunnels best-effort unmarshals raw JSON tunnel entries (as
// found in the legacy Electron store's json.RawMessage-typed tunnels field)
// into SavedTunnelConfig, silently dropping entries that don't parse or
// don't validate - mirrors the original's isSavedTunnelConfig filter, which
// treats a malformed stored tunnel as "not there" rather than a hard error.
func parseLegacyTunnels(raw []json.RawMessage) []SavedTunnelConfig {
	out := make([]SavedTunnelConfig, 0, len(raw))
	for _, r := range raw {
		var t SavedTunnelConfig
		if err := json.Unmarshal(r, &t); err != nil {
			continue
		}
		if !isValidTunnelConfig(t) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// GetTunnels mirrors getTunnels: every saved tunnel for savedConnectionID.
func (s *Store) GetTunnels(savedConnectionID string) ([]SavedTunnelConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return nil, err
	}

	for _, connection := range data.Connections {
		if connection.ID == savedConnectionID {
			return normalizeTunnels(connection.Tunnels), nil
		}
	}
	return nil, fmt.Errorf("saved connection not found")
}

// GetTunnel mirrors getTunnel: one saved tunnel by id within a connection.
func (s *Store) GetTunnel(savedConnectionID, tunnelID string) (SavedTunnelConfig, error) {
	tunnels, err := s.GetTunnels(savedConnectionID)
	if err != nil {
		return SavedTunnelConfig{}, err
	}
	for _, t := range tunnels {
		if t.ID == tunnelID {
			return t, nil
		}
	}
	return SavedTunnelConfig{}, fmt.Errorf("tunnel not found")
}

// SaveTunnel mirrors saveTunnel: upserts tunnel by id within
// savedConnectionID's tunnel list (new tunnels are prepended, matching the
// original's most-recently-saved-first ordering).
func (s *Store) SaveTunnel(savedConnectionID string, tunnel SavedTunnelConfig) error {
	normalized, ok := normalizeTunnelConfig(tunnel)
	if !ok {
		return fmt.Errorf("invalid tunnel configuration")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return err
	}

	changed := false
	for i := range data.Connections {
		if data.Connections[i].ID != savedConnectionID {
			continue
		}

		current := normalizeTunnels(data.Connections[i].Tunnels)
		existingIndex := -1
		for j, t := range current {
			if t.ID == normalized.ID {
				existingIndex = j
				break
			}
		}

		if existingIndex == -1 {
			data.Connections[i].Tunnels = append([]SavedTunnelConfig{normalized}, current...)
		} else {
			current[existingIndex] = normalized
			data.Connections[i].Tunnels = current
		}
		changed = true
	}

	if !changed {
		return fmt.Errorf("saved connection not found")
	}
	return s.writeDataLocked(data)
}

// RemoveTunnel mirrors removeTunnel.
func (s *Store) RemoveTunnel(savedConnectionID, tunnelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return err
	}

	changed := false
	for i := range data.Connections {
		if data.Connections[i].ID != savedConnectionID {
			continue
		}
		data.Connections[i].Tunnels = filterTunnels(normalizeTunnels(data.Connections[i].Tunnels), tunnelID)
		changed = true
	}

	if !changed {
		return fmt.Errorf("saved connection not found")
	}
	return s.writeDataLocked(data)
}

func filterTunnels(tunnels []SavedTunnelConfig, excludeID string) []SavedTunnelConfig {
	out := make([]SavedTunnelConfig, 0, len(tunnels))
	for _, t := range tunnels {
		if t.ID != excludeID {
			out = append(out, t)
		}
	}
	return out
}
