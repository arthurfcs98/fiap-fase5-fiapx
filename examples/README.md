# Vídeos de exemplo

Vídeos pequenos (versionados) para experimentar o FIAP Frames sem procurar arquivos. Gerados por
`tests/fixtures/generate.sh --examples` (precisa de `ffmpeg`).

| Arquivo | Conteúdo | Resultado esperado |
|---|---|---|
| `sample-ok-5s.mp4` | padrão de teste, 5 s, 320x240 | `COMPLETED`, zip com 5 PNGs |
| `sample-ok-10s.mp4` | padrão de teste, 10 s, 640x360 | `COMPLETED`, zip com 10 PNGs |
| `sample-corrupt.mp4` | cabeçalho MP4 + bytes aleatórios | aceito (`202`), termina `FAILED` `P0001` e gera o e-mail de falha |

Como usar: [`docs/exemplos.md`](../docs/exemplos.md) (curl, frontend, RabbitMQ, Mailpit),
[`docs/exemplos.http`](../docs/exemplos.http) (VS Code REST Client) e `make demo-happy` /
`make demo-sad`.
