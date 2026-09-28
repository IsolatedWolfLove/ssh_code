package ssh

import (
	"io"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// Keep agent sockets scoped to each request. Agent-backed signers otherwise
// retain the connection for the lifetime of the application after login.
type socketSigner struct {
	socket string
	key    ssh.PublicKey
}

func (s socketSigner) PublicKey() ssh.PublicKey { return s.key }
func (s socketSigner) Sign(_ io.Reader, data []byte) (*ssh.Signature, error) {
	return s.SignWithAlgorithm(nil, data, "")
}
func (s socketSigner) SignWithAlgorithm(_ io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	c, e := net.DialTimeout("unix", s.socket, 5*time.Second)
	if e != nil {
		return nil, e
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(15 * time.Second))
	flags := agent.SignatureFlags(0)
	switch algorithm {
	case ssh.KeyAlgoRSASHA256:
		flags = agent.SignatureFlagRsaSha256
	case ssh.KeyAlgoRSASHA512:
		flags = agent.SignatureFlagRsaSha512
	}
	return agent.NewClient(c).SignWithFlags(s.key, data, flags)
}
func agentSigners(socket string) ([]ssh.Signer, error) {
	c, e := net.DialTimeout("unix", socket, 5*time.Second)
	if e != nil {
		return nil, e
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	signers, e := agent.NewClient(c).Signers()
	if e != nil {
		return nil, e
	}
	out := make([]ssh.Signer, 0, len(signers))
	for _, s := range signers {
		out = append(out, socketSigner{socket, s.PublicKey()})
	}
	return out, nil
}
