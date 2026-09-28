# FIAP X — atalhos de desenvolvimento. `make help` lista os alvos.
SHELL := /usr/bin/env bash
COMPOSE ?= docker compose
APPS := video-api video-worker notification-service

.DEFAULT_GOAL := help
.PHONY: help secrets up down down-v logs ps smoke test test-cov test-e2e lint typecheck build images

help: ## Lista os alvos disponíveis
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

secrets: ## Gera/completa o .env local com segredos aleatórios (idempotente)
	@./scripts/dev-secrets.sh

# As portas publicadas vêm do .env (que o make não lê): a mensagem pergunta ao próprio compose.
up: secrets ## Sobe infra + apps (build local) e espera tudo ficar healthy
	$(COMPOSE) up -d --build --wait --wait-timeout 300
	@echo "API: http://$$($(COMPOSE) port video-api 3000)/api/docs · Mailpit: http://$$($(COMPOSE) port mailpit 8025) · RabbitMQ: http://$$($(COMPOSE) port rabbitmq 15672)"

down: ## Derruba o stack (mantém os volumes)
	$(COMPOSE) down

down-v: ## Derruba o stack e APAGA os volumes (banco, filas, storage)
	$(COMPOSE) down -v

logs: ## Acompanha os logs (ex.: make logs S=video-api)
	$(COMPOSE) logs -f --tail=100 $(S)

ps: ## Estado dos containers
	$(COMPOSE) ps -a

smoke: ## Smoke do stack em execução (health, métricas, buckets)
	@./scripts/compose-smoke.sh

test: ## Testes unitários de todos os projects
	npm test

test-cov: ## Cobertura por project (threshold de 80% em cada um)
	npm run test:cov

test-e2e: ## E2E do video-api (supertest)
	npm run test:e2e

lint: ## ESLint (zero warnings) + Prettier
	npm run lint

typecheck: ## tsc --noEmit em todo o monorepo
	npm run typecheck

build: ## Build (webpack) dos 3 apps em dist/apps
	npm run build

images: secrets ## Build das 3 imagens Docker (tags do compose)
	$(COMPOSE) build $(APPS)
