# Projeto base (o "antes")

Código original entregue pela FIAP como ponto de partida do hackathon, mantido **intacto**
aqui só como referência histórica. Não faz parte do build nem do CI.

| Arquivo | Conteúdo |
|---|---|
| `main.go` | Servidor HTTP único em Go: formulário HTML, upload, `ffmpeg -vf fps=1` e zip dos PNGs |
| `Dockerfile` | Imagem do servidor Go com ffmpeg |
| `go.mod`, `go.sum` | Dependências do módulo Go |

## Por que foi reescrito

- Processamento **síncrono** dentro da requisição HTTP: um vídeo longo trava a resposta e
  picos de uso derrubam o serviço.
- Sem persistência nem fila: um restart perde tudo e não há como escalar horizontalmente.
- Sem autenticação, sem listagem de status por usuário e sem notificação de falha.
- Validação só pela extensão do arquivo e nenhum limite de tamanho/duração.

A nova arquitetura (três microsserviços NestJS, RabbitMQ, PostgreSQL e storage S3) reaproveita
o essencial daqui: a mesma lista de extensões aceitas e os mesmos argumentos do ffmpeg
(`fps=1`, saída `frame_%04d.png`).
