# shellcheck shell=bash
# infra/vm/site-env.sh — carrega infra/vm/.env: os valores DESTA VM que não entram no repositório
# (ele é público): sites e containers dos vizinhos, o lock do deploy automático deles e os IPs
# públicos da VM. Modelo com a explicação de cada chave: infra/vm/.env.example.
#
# Incluído (source) pelos scripts 00, 30, 90 e 99. Não executa o .env: lê só linhas CHAVE=valor
# das chaves abaixo e confere o formato de cada valor. Variável já definida no ambiente vale mais
# que o arquivo (ex.: NEIGHBOR_DEPLOY_LOCK=nenhum ./90-stop-k3s.sh --yes).

SITE_ENV_KEYS=(NEIGHBOR_SITES NEIGHBOR_CONTAINERS NEIGHBOR_DEPLOY_LOCK VM_PUBLIC_IP VM_PUBLIC_IP6)
SITE_ENV_FILE=""

site_env_load() {  # site_env_load <diretório dos scripts>
  local f=$1/.env line key val
  for key in "${SITE_ENV_KEYS[@]}"; do printf -v "$key" '%s' "${!key:-}"; done
  if [[ -f $f ]]; then
    SITE_ENV_FILE=$f
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*([A-Z0-9_]+)=(.*)$ ]] || continue
      key=${BASH_REMATCH[1]} val=${BASH_REMATCH[2]}
      case " ${SITE_ENV_KEYS[*]} " in *" $key "*) ;; *) continue ;; esac
      [[ -z ${!key} ]] || continue                       # o ambiente vence o arquivo
      val=${val%%[[:space:]]#*}                          # comentário no fim da linha
      val=${val%"${val##*[![:space:]]}"}                 # espaços no fim
      val=${val#\"}; val=${val%\"}; val=${val#\'}; val=${val%\'}
      printf -v "$key" '%s' "$val"
    done < "$f"
  fi
  site_env_validate
}

site_env_validate() {  # formato de cada valor (vão para curl, docker e flock como argumentos)
  local h
  for h in $NEIGHBOR_SITES; do
    [[ $h =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || site_env_die "NEIGHBOR_SITES: '$h' não é um hostname"
  done
  for h in $NEIGHBOR_CONTAINERS; do
    [[ $h =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || site_env_die "NEIGHBOR_CONTAINERS: '$h' não é um nome de container"
  done
  [[ -z $NEIGHBOR_DEPLOY_LOCK || $NEIGHBOR_DEPLOY_LOCK == nenhum || $NEIGHBOR_DEPLOY_LOCK =~ ^/[A-Za-z0-9_./-]+$ ]] \
    || site_env_die "NEIGHBOR_DEPLOY_LOCK: use um caminho absoluto ou 'nenhum'"
  [[ -z $VM_PUBLIC_IP || $VM_PUBLIC_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || site_env_die "VM_PUBLIC_IP: IPv4 inválido"
  [[ -z $VM_PUBLIC_IP6 || $VM_PUBLIC_IP6 =~ ^[0-9A-Fa-f:]+$ ]] || site_env_die "VM_PUBLIC_IP6: IPv6 inválido"
  return 0
}

site_env_die() { printf '\nERRO em %s: %s\n' "${SITE_ENV_FILE:-ambiente}" "$*" >&2; exit 2; }

site_env_hint() {  # linha de ajuda para quando falta uma chave
  printf 'crie infra/vm/.env a partir de infra/vm/.env.example (a cópia por tar leva o arquivo para a VM)'
}

# Código HTTP de um site servido pela borda local (127.0.0.1:443 com SNI), sem passar pela Cloudflare.
site_edge_code() {  # site_edge_code <host> [caminho]
  curl -sS -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$1:443:127.0.0.1" "https://$1${2:-/}" 2>/dev/null || true
}

# Sites vizinhos pela borda local. Imprime "host=código ..." e devolve:
#   0 todos 2xx/3xx · 1 algum fora disso · 2 NEIGHBOR_SITES vazio (nada a conferir)
neighbor_sites_check() {
  local h c rc=0 out=""
  [[ -n ${NEIGHBOR_SITES// /} ]] || { printf '(NEIGHBOR_SITES vazio)'; return 2; }
  for h in $NEIGHBOR_SITES; do
    c=$(site_edge_code "$h")
    out+="$h=$c "
    [[ $c =~ ^[23] ]] || rc=1
  done
  printf '%s' "${out% }"
  return "$rc"
}

# Lock do deploy automático dos vizinhos (fd 8). Segurado enquanto o k3s-killall/k3s-uninstall
# reescrevem o iptables sem --noflush: um "compose up" no meio perderia regras do Docker.
NEIGHBOR_LOCK_HELD=0
neighbor_lock_acquire() {
  case $NEIGHBOR_DEPLOY_LOCK in
    "") site_env_die "NEIGHBOR_DEPLOY_LOCK vazio: defina o lock do deploy dos vizinhos, ou 'nenhum' ($(site_env_hint))" ;;
    nenhum) printf '    AVISO: NEIGHBOR_DEPLOY_LOCK=nenhum: seguindo sem lock (confira que nenhum "compose up" está rodando)\n'; return 0 ;;
  esac
  if [[ ! -e $NEIGHBOR_DEPLOY_LOCK ]]; then
    printf '    AVISO: %s não existe; seguindo sem o lock (confira que nenhum "compose up" está rodando)\n' "$NEIGHBOR_DEPLOY_LOCK"
    return 0
  fi
  exec 8>>"$NEIGHBOR_DEPLOY_LOCK"
  if ! flock -w 600 8; then
    printf '\nERRO: o deploy dos vizinhos segurou %s por 10 min; tente de novo\n' "$NEIGHBOR_DEPLOY_LOCK" >&2
    exit 1
  fi
  NEIGHBOR_LOCK_HELD=1
  printf '    lock do deploy dos vizinhos obtido (%s)\n' "$NEIGHBOR_DEPLOY_LOCK"
}
neighbor_lock_release() {
  if (( NEIGHBOR_LOCK_HELD )); then
    flock -u 8; exec 8>&-; NEIGHBOR_LOCK_HELD=0
    printf '    lock do deploy dos vizinhos liberado\n'
  fi
}
