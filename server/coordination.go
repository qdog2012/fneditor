package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

const handoffTTL int64 = 15000
const instanceTTL int64 = 3000

type handoffRequest struct {
	Type           string `json:"type"`
	ID             string `json:"id"`
	SourceID       string `json:"sourceId"`
	Path           string `json:"path"`
	CreatedAt      int64  `json:"createdAt"`
	Acknowledged   bool   `json:"acknowledged"`
	AcknowledgedAt int64  `json:"acknowledgedAt,omitempty"`
}
type diagnosticEvent struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	Source    string `json:"source"`
	Event     string `json:"event"`
	Data      any    `json:"data"`
}

func parseBoolean(value any) (bool, bool) {
	switch value := value.(type) {
	case bool:
		return value, true
	case float64:
		if value == 0 || value == 1 {
			return value == 1, true
		}
	case string:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1", "true", "yes", "on":
			return true, true
		case "0", "false", "no", "off":
			return false, true
		}
	}
	return false, false
}
func truncateString(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}
func sanitize(value any, depth int) any {
	switch value := value.(type) {
	case nil, bool, float64, float32, int, int64, int32, uint, uint64, uint32:
		return value
	case string:
		if len([]rune(value)) > 800 {
			return truncateString(value, 800) + "..."
		}
		return value
	case []any:
		if depth >= 4 {
			return "[truncated]"
		}
		result := make([]any, min(len(value), 40))
		for i := range result {
			result[i] = sanitize(value[i], depth+1)
		}
		return result
	case map[string]any:
		if depth >= 4 {
			return "[truncated]"
		}
		result := map[string]any{}
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys[:min(len(keys), 80)] {
			result[key] = sanitize(value[key], depth+1)
		}
		return result
	default:
		return fmt.Sprint(value)
	}
}

func (s *server) syncDiagnostics(r *http.Request, body map[string]any) {
	value := body["debugLoggingEnabled"]
	if value == nil {
		value = r.URL.Query().Get("debugLoggingEnabled")
	}
	if enabled, ok := parseBoolean(value); ok {
		s.eventsMu.Lock()
		s.debugEnabled = enabled
		s.eventsMu.Unlock()
	}
}
func (s *server) diagnostic(source, event string, data any) bool {
	s.eventsMu.Lock()
	defer s.eventsMu.Unlock()
	if !s.debugEnabled {
		return false
	}
	var id [12]byte
	_, _ = rand.Read(id[:])
	if source == "" {
		source = "unknown"
	}
	if event == "" {
		event = "event"
	}
	item := diagnosticEvent{hex.EncodeToString(id[:]), isoTime(time.Now()), truncateString(source, 80), truncateString(event, 120), sanitize(data, 0)}
	s.diagnostics = append(s.diagnostics, item)
	if len(s.diagnostics) > 800 {
		copy(s.diagnostics, s.diagnostics[len(s.diagnostics)-800:])
		s.diagnostics = s.diagnostics[:800]
	}
	return true
}
func (s *server) diagnosticSnapshot() (bool, []diagnosticEvent) {
	s.eventsMu.Lock()
	defer s.eventsMu.Unlock()
	items := make([]diagnosticEvent, len(s.diagnostics))
	copy(items, s.diagnostics)
	return s.debugEnabled, items
}

// coordMu protects instance selection, request acknowledgement, and SSE subscriptions.
func (s *server) cleanupCoordination(now int64) {
	for id, updated := range s.instances {
		if now-updated > instanceTTL {
			delete(s.instances, id)
		}
	}
	order := s.handoffOrder[:0]
	for _, id := range s.handoffOrder {
		request := s.handoffs[id]
		if request == nil || now-request.CreatedAt > handoffTTL {
			delete(s.handoffs, id)
		} else {
			order = append(order, id)
		}
	}
	s.handoffOrder = order
}
func (s *server) primary(exclude string) (string, int64) {
	id, updated := "", int64(0)
	for candidate, timestamp := range s.instances {
		if candidate != exclude && (id == "" || timestamp > updated || (timestamp == updated && candidate < id)) {
			id, updated = candidate, timestamp
		}
	}
	return id, updated
}

func (s *server) registerCoordination(register func(string, int, endpoint)) {
	register("POST /api/instances/heartbeat", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		id := bodyString(body, "id")
		if id == "" {
			return nil, fail(400, "缺少实例 id")
		}
		now := time.Now().UnixMilli()
		s.coordMu.Lock()
		s.cleanupCoordination(now)
		s.instances[id] = now
		s.coordMu.Unlock()
		return map[string]any{"ok": true}, nil
	})
	register("POST /api/instances/claim", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		s.syncDiagnostics(r, body)
		id := bodyString(body, "id")
		if id == "" {
			return nil, fail(400, "缺少实例 id")
		}
		now := time.Now().UnixMilli()
		s.coordMu.Lock()
		s.cleanupCoordination(now)
		primary, updated := s.primary(id)
		if primary == "" {
			s.instances[id] = now
		}
		s.coordMu.Unlock()
		if primary != "" {
			s.diagnostic("server", "instance-claim-existing-primary", map[string]any{"sourceId": id, "primaryId": primary, "ageMs": now - updated})
			return map[string]any{"active": true, "id": primary, "ageMs": now - updated}, nil
		}
		s.diagnostic("server", "instance-claim-new-primary", map[string]any{"sourceId": id})
		return map[string]any{"active": false, "id": id, "ageMs": 0}, nil
	})
	register("GET /api/instances/primary", 200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		s.syncDiagnostics(r, nil)
		source := strings.TrimSpace(r.URL.Query().Get("sourceId"))
		now := time.Now().UnixMilli()
		s.coordMu.Lock()
		s.cleanupCoordination(now)
		primary, updated := s.primary(source)
		s.coordMu.Unlock()
		age := int64(0)
		if primary != "" {
			age = now - updated
		}
		s.diagnostic("server", "instance-primary-check", map[string]any{"sourceId": source, "active": primary != "", "primaryId": primary, "ageMs": age})
		return map[string]any{"active": primary != "", "id": primary, "ageMs": age}, nil
	})
	register("DELETE /api/instances/{id}", 200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		s.coordMu.Lock()
		delete(s.instances, r.PathValue("id"))
		s.coordMu.Unlock()
		return map[string]any{"ok": true}, nil
	})
	register("POST /api/instances/release", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		s.coordMu.Lock()
		delete(s.instances, bodyString(body, "id"))
		s.coordMu.Unlock()
		return map[string]any{"ok": true}, nil
	})
	register("POST /api/handoff/open", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		s.syncDiagnostics(r, body)
		id, source, requested := bodyString(body, "id"), bodyString(body, "sourceId"), bodyString(body, "path")
		if id == "" || source == "" || requested == "" {
			return nil, fail(400, "缺少打开请求参数")
		}
		now := time.Now().UnixMilli()
		created := now
		if value, ok := body["createdAt"].(float64); ok && value >= float64(now-handoffTTL) && value <= float64(now+handoffTTL) {
			created = int64(value)
		}
		request := handoffRequest{Type: "open-file", ID: id, SourceID: source, Path: requested, CreatedAt: created}
		s.coordMu.Lock()
		s.cleanupCoordination(now)
		if s.handoffs[id] == nil {
			s.handoffOrder = append(s.handoffOrder, id)
		}
		s.handoffs[id] = &request
		for client := range s.clients {
			select {
			case client <- request:
			default:
				delete(s.clients, client)
				close(client)
			}
		}
		s.coordMu.Unlock()
		s.diagnostic("server", "handoff-open", map[string]any{"id": id, "sourceId": source, "path": requested, "createdAt": created})
		return map[string]any{"ok": true}, nil
	})
	register("GET /api/handoff/status", 200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		s.coordMu.Lock()
		defer s.coordMu.Unlock()
		s.cleanupCoordination(time.Now().UnixMilli())
		request := s.handoffs[strings.TrimSpace(r.URL.Query().Get("id"))]
		return map[string]any{"acknowledged": request != nil && request.Acknowledged}, nil
	})
	register("GET /api/handoff/pending", 200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		s.coordMu.Lock()
		defer s.coordMu.Unlock()
		s.cleanupCoordination(time.Now().UnixMilli())
		source := strings.TrimSpace(r.URL.Query().Get("sourceId"))
		items := []handoffRequest{}
		for _, id := range s.handoffOrder {
			request := s.handoffs[id]
			if !request.Acknowledged && request.SourceID != source {
				items = append(items, *request)
			}
		}
		if len(items) > 20 {
			items = items[len(items)-20:]
		}
		return map[string]any{"items": items}, nil
	})
	register("POST /api/handoff/ack", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		s.syncDiagnostics(r, body)
		id := bodyString(body, "id")
		if id == "" {
			return nil, fail(400, "缺少请求 id")
		}
		s.coordMu.Lock()
		s.cleanupCoordination(time.Now().UnixMilli())
		request := s.handoffs[id]
		if request != nil {
			request.Acknowledged = true
			request.AcknowledgedAt = time.Now().UnixMilli()
		}
		s.coordMu.Unlock()
		s.diagnostic("server", "handoff-ack", map[string]any{"id": id, "found": request != nil})
		return map[string]any{"ok": true}, nil
	})
}

func (s *server) streamEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming is unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	client := make(chan handoffRequest, 64)
	s.coordMu.Lock()
	s.clients[client] = struct{}{}
	s.coordMu.Unlock()
	defer func() { s.coordMu.Lock(); delete(s.clients, client); s.coordMu.Unlock() }()
	send := func(event string, data any) error {
		// Bound stalled clients without imposing a timeout on the lifetime of SSE.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
		encoded, _ := json.Marshal(data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if err := send("ready", map[string]any{"ok": true}); err != nil {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		case request, ok := <-client:
			if !ok {
				return
			}
			if err := send("open-file", request); err != nil {
				return
			}
		case <-ticker.C:
			if err := send("ping", map[string]any{"now": time.Now().UnixMilli()}); err != nil {
				return
			}
		}
	}
}

func (s *server) registerDiagnostics(register func(string, int, endpoint)) {
	register("GET /api/diagnostics/settings", 200, func(_ http.ResponseWriter, _ *http.Request) (any, error) {
		enabled, _ := s.diagnosticSnapshot()
		return map[string]any{"enabled": enabled}, nil
	})
	register("PUT /api/diagnostics/settings", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		enabled, ok := parseBoolean(body["enabled"])
		if !ok {
			return nil, fail(400, "缺少调试日志开关状态")
		}
		if err := s.updateState(map[string]any{"debugLoggingEnabled": enabled}); err != nil {
			return nil, err
		}
		s.eventsMu.Lock()
		s.debugEnabled = enabled
		s.eventsMu.Unlock()
		return map[string]any{"ok": true, "enabled": enabled}, nil
	})
	register("POST /api/diagnostics/events", 200, func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		s.syncDiagnostics(r, body)
		data := body["data"]
		if data == nil {
			data = map[string]any{}
		}
		recorded := s.diagnostic(stringValue(body["source"]), stringValue(body["event"]), data)
		enabled, _ := s.diagnosticSnapshot()
		return map[string]any{"ok": true, "enabled": enabled, "recorded": recorded}, nil
	})
	register("GET /api/diagnostics/events", 200, func(_ http.ResponseWriter, _ *http.Request) (any, error) {
		enabled, items := s.diagnosticSnapshot()
		return map[string]any{"enabled": enabled, "items": items}, nil
	})
	register("GET /api/diagnostics/events.txt", 200, func(w http.ResponseWriter, _ *http.Request) (any, error) {
		_, items := s.diagnosticSnapshot()
		lines := []string{}
		for _, item := range items {
			data, _ := json.Marshal(item.Data)
			lines = append(lines, strings.Join([]string{item.CreatedAt, item.Source, item.Event, string(data)}, " "))
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, err := fmt.Fprint(w, strings.Join(lines, "\n")+"\n")
		return nil, err
	})
	register("DELETE /api/diagnostics/events", 200, func(_ http.ResponseWriter, _ *http.Request) (any, error) {
		s.eventsMu.Lock()
		s.diagnostics = []diagnosticEvent{}
		s.eventsMu.Unlock()
		return map[string]any{"ok": true}, nil
	})
}
