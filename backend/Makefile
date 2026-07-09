.PHONY: test test-unit up down accept fmt vet tidy

# Hermetic unit tests (no OpenFGA needed): pure permission logic + mock IdP.
test-unit:
	go test ./sync/... ./org/...

# Everything. Acceptance tests skip automatically if OpenFGA isn't running.
test:
	go test ./...

# Start / stop local OpenFGA (host port 8090).
up:
	docker compose up -d

down:
	docker compose down

# Full acceptance run: bring up OpenFGA, wait for it, run tests.
accept: up
	@echo "waiting for OpenFGA on :18080 ..."
	@for i in $$(seq 1 30); do \
		if curl -fsS -m 2 http://localhost:18080/healthz 2>/dev/null | grep -q SERVING; then \
			echo "OpenFGA ready"; break; fi; sleep 1; done
	go test ./authz/... -run Acceptance -v

fmt:
	go fmt ./...

vet:
	go vet ./...

tidy:
	go mod tidy
