# Runbook: incidente com dados pessoais (LGPD art. 48)

> Quando usar: suspeita ou confirmação de acesso indevido, vazamento, perda ou alteração de dados
> pessoais do FIAP Frames (usuários, vídeos, zips, e-mails, notificações). Mapa de dados e retenção:
> [`docs/lgpd.md`](../lgpd.md). Contrato: [`contratos.md`](../arquitetura/contratos.md), seção 12.
>
> Regra de ouro: **conter primeiro, registrar tudo, comunicar dentro do prazo**. Cada passo abaixo
> tem um responsável (hoje, o Arthur) e deixa um registro com data/hora (UTC) no relatório do
> incidente (modelo na seção 6).

## 0. Gatilhos típicos

| Sinal | Onde aparece |
|---|---|
| Segredo no Git (JWT, S3, banco, Resend) | alerta do gitleaks no CI / pre-commit, aviso do GitHub secret scanning |
| Muitos 401/403/429, downloads fora do padrão, pico de `V0005` | Grafana → dashboard `FIAP Frames — SLOs`; Loki: `{namespace="fiapx"} \| json \| error_code="V0005"` |
| Acesso não esperado a buckets/banco | logs do Garage/Postgres, `pg_stat_activity` (`application_name`) |
| Aviso de terceiro (usuário, pesquisador, fornecedor: Resend, Cloudflare, provedor da VM) | e-mail de contato da política |
| E-mail enviado ao destinatário errado | `notifications` (notification-service), logs com `correlationId` |

## 1. Identificar (até 1 h)

1. Abrir o relatório do incidente (seção 6) e anotar hora da detecção, quem detectou e o sinal.
2. Delimitar **o quê**: quais dados (tabela do mapa em `docs/lgpd.md`), quais usuários (só IDs),
   qual período.
3. Seguir o caminho pelo `correlationId` quando houver uma requisição/vídeo envolvido:
   `{namespace="fiapx"} | json | correlationId="<id>"` (HTTP → outbox → AMQP → worker → e-mail).
4. Classificar a gravidade inicial:
   - **Alta**: senha/segredo de sistema exposto, acesso a buckets ou ao banco, e-mails em massa.
   - **Média**: poucos titulares afetados, dado exposto por pouco tempo.
   - **Baixa**: sem evidência de acesso (ex.: segredo exposto e rotacionado antes de qualquer uso).

## 2. Conter (imediato)

| Situação | Ação |
|---|---|
| `JWT_SECRET` exposto | Gerar novo segredo, atualizar o Secret do K8s e reiniciar o video-api (`kubectl rollout restart deploy/video-api -n fiapx`). **Todos os tokens emitidos param de valer.** |
| `DOWNLOAD_URL_SECRET` exposto | Mesmo procedimento: links de download antigos passam a responder `403 V0005`. |
| Chave S3 (Garage) exposta | Criar chave nova, revogar a antiga no Garage, atualizar Secrets, reiniciar api e worker. |
| Senha do Postgres/RabbitMQ/Redis exposta | Trocar a senha do role/usuário, atualizar Secrets, reiniciar os serviços que a usam. |
| `RESEND_API_KEY` exposta | Revogar no painel do Resend, gerar nova, atualizar o Secret do notification-service. |
| Conta de usuário comprometida | O próprio titular (ou o operador, a pedido dele) pode eliminar a conta (`DELETE /api/me`); tokens antigos são rejeitados porque o usuário deixa de existir. |
| Abuso em andamento (enumeração, força bruta) | Bloquear na Cloudflare (regra de WAF/IP); se preciso, reduzir os limites do video-api (`THROTTLE_REGISTER_LIMIT`, `THROTTLE_LOGIN_LIMIT`, `THROTTLE_UPLOAD_LIMIT` no ConfigMap `video-api`) e reiniciar o deployment. |
| Segredo commitado por engano | O pre-commit (`gitleaks protect --staged`) e o job `security` do CI (gitleaks no histórico inteiro) apontam o arquivo e a linha; tratar como exposto (linha acima) mesmo que o push não tenha acontecido. |
| Vazamento pelo repositório público | Remover o conteúdo, **rotacionar o segredo mesmo assim** (histórico do Git é público). |

Preservar evidências **antes** de apagar qualquer coisa: exportar os logs relevantes do Loki
(retenção de 72 h!) e anotar os IDs envolvidos. Nunca copiar dados pessoais para o relatório:
registrar só IDs e contagens.

## 3. Avaliar (até 24 h)

- Quantos titulares e quais categorias de dados (nome, e-mail, conteúdo de vídeo, zip).
- Os dados estavam protegidos? (senha só como bcrypt; buckets privados; links expiram em 5 min;
  vídeos originais já apagados após o processamento; zips com retenção de 7 dias).
- Probabilidade de **risco ou dano relevante** aos titulares (art. 48): exposição de imagem de
  pessoas nos vídeos e de e-mail tende a ser relevante; um segredo rotacionado sem uso, não.
- Causa raiz e se ainda há exposição.

## 4. Comunicar

- **ANPD**: se houver risco ou dano relevante, comunicar em prazo razoável (referência da
  Resolução CD/ANPD nº 15/2024: **3 dias úteis** a partir do conhecimento), pelo formulário do
  site da ANPD, com: descrição da natureza dos dados, titulares envolvidos, medidas técnicas de
  proteção, riscos, motivo de eventual demora e medidas tomadas para reverter/mitigar.
- **Titulares afetados**: e-mail em linguagem simples com o que aconteceu, quais dados, o que já
  foi feito e o que o titular pode fazer (ex.: trocar a senha em outros serviços, excluir a conta).
- **Banca/orientação da FIAP** (projeto acadêmico): informar o ocorrido e as medidas.
- Operadores envolvidos (Resend, Cloudflare, provedor da VM), se o incidente passar por eles.

## 5. Encerrar e aprender

1. Confirmar que a contenção funcionou (métricas e logs normais por 24 h).
2. Corrigir a causa raiz no código/infra com PR e teste de regressão.
3. Atualizar `docs/lgpd.md`, este runbook e `contratos.md` se alguma regra mudou.
4. Guardar o relatório (sem dados pessoais) junto dos documentos do projeto.

## 6. Modelo de relatório

```
Incidente: <id curto>            Gravidade: alta | média | baixa
Detectado em (UTC):              Por:                 Sinal:
Dados afetados (categorias):     Titulares (quantidade / IDs):
Período de exposição:
Linha do tempo (UTC):
  - hh:mm  detecção
  - hh:mm  contenção (o quê)
  - hh:mm  avaliação concluída
  - hh:mm  comunicação ANPD (protocolo) / titulares
Causa raiz:
Medidas corretivas (PRs):
Lições aprendidas:
```
