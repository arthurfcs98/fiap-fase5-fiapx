# language: pt
Funcionalidade: Processamento de vídeo e download do zip
  Como usuário do FIAP Frames
  Quero enviar um vídeo e baixar os frames em um arquivo .zip
  Para não precisar extrair as imagens manualmente

  Cenário: usuário processa vídeo e baixa o zip
    Dado que estou cadastrado e autenticado
    Quando envio o vídeo "sample-ok-5s.mp4" de 5 segundos
    Então a API aceita o envio com status 202 e o vídeo fica "QUEUED"
    E o vídeo termina com status "COMPLETED" e 5 frames
    E o histórico mostra QUEUED, PROCESSING e COMPLETED
    E o vídeo original é apagado do storage
    Quando peço o link de download do zip
    Então baixo um arquivo zip com 5 imagens PNG
