package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

// fileResult is the desktop's reply to a file_request.
type fileResult struct {
	content string
	err     string
}

// fileBridge implements connector.FileBridge for one chat turn: it emits a
// file_request over that turn's SSE stream and blocks on a per-request channel
// registered in the server's pending map, which /chat/file-result resolves
// (design §2, option A — the desktop executes behind fsguard + confirmation).
type fileBridge struct {
	srv  *server
	send func(kind string, v any)
}

func (b *fileBridge) RequestFile(ctx context.Context, op, path, contents string) (string, error) {
	id := newReqID()
	ch := make(chan fileResult, 1)
	b.srv.mu.Lock()
	b.srv.pending[id] = ch
	b.srv.mu.Unlock()
	defer func() {
		b.srv.mu.Lock()
		delete(b.srv.pending, id)
		b.srv.mu.Unlock()
	}()

	b.send("file_request", map[string]any{
		"kind": "file_request", "reqId": id, "op": op, "path": path, "content": contents,
	})

	select {
	case r := <-ch:
		if r.err != "" {
			return "", errors.New(r.err)
		}
		return r.content, nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(120 * time.Second):
		return "", errors.New("file request timed out (no client response)")
	}
}

// resolveFile delivers a desktop reply to the waiting RequestFile. Returns false
// if no request is pending for the id.
func (s *server) resolveFile(reqID string, res fileResult) bool {
	s.mu.Lock()
	ch := s.pending[reqID]
	s.mu.Unlock()
	if ch == nil {
		return false
	}
	ch <- res
	return true
}

func newReqID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
