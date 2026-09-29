# FIAP Frames — atalhos de desenvolvimento. `make help` lista os alvos.
SHELL := /usr/bin/env bash
COMPOSE ?= docker compose
APPS := video-api video-worker notification-service

.DEFAULT_GOAL := help
# Réplicas do video-worker no `make up` (ex.: make up WORKERS=3).
WORKERS ?= 1
# Stack do BDD: 3 workers (cenário de pico) e retenção do zip curta (~43 s, cenário de retenção).
BDD_ENV := ZIP_RETENTION_DAYS=0.0005 DATA_RETENTION_INTERVAL_S=10
# Teste de carga (k6): usuários virtuais e duração do pico.
VUS ?= 20
DURATION ?= 30s

.PHONY: help secrets fixtures up down down-v logs ps smoke test test-cov test-e2e test-int test-bdd \
	bdd-up load demo-happy demo-sad lint typecheck build images

help: ## Lista os alvos disponíveis
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

secrets: ## Gera/completa o .env local com segredos aleatórios (idempotente)
	@./scripts/dev-secrets.sh

fixtures: ## Gera os vídeos de teste em tests/fixtures (precisa de ffmpeg)
	@./tests/fixtures/generate.sh

# As portas publicadas vêm do .env (que o make não lê): a mensagem pergunta ao próprio compose.
up: secrets ## Sobe infra + migrações + apps (build local) e espera healthy (WORKERS=n réplicas do worker)
	$(COMPOSE) up -d --build --wait --wait-timeout 300 --scale video-worker=$(WORKERS)
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

test-int: ## Integração com RabbitMQ/Postgres/Garage reais (Testcontainers; precisa de Docker e ffmpeg)
	npm run test:int

bdd-up: secrets ## Sobe o stack do BDD (3 workers, retenção do zip curta; volte com make up)
	$(BDD_ENV) $(COMPOSE) up -d --build --wait --wait-timeout 300 --scale video-worker=3

test-bdd: bdd-up ## BDD E2E (jest-cucumber, features em pt-BR) contra o stack do compose
	npm run test:bdd

load: ## Teste de pico com k6 contra o stack no ar (VUS=20 DURATION=30s)
	k6 run -e VUS=$(VUS) -e DURATION=$(DURATION) tests/load/spike.js

demo-happy: ## Demo: cadastro, upload, processamento e download do zip (scripts/demo)
	@./scripts/demo/happy-path.sh

demo-sad: ## Demo: vídeo corrompido termina em FAILED e o e-mail chega no Mailpit
	@./scripts/demo/sad-path.sh

lint: ## ESLint (zero warnings) + Prettier
	npm run lint

typecheck: ## tsc --noEmit em todo o monorepo
	npm run typecheck

build: ## Build (webpack) dos 3 apps em dist/apps
	npm run build

images: secrets ## Build das 3 imagens Docker (tags do compose)
	$(COMPOSE) build $(APPS)
