# language: pt
Funcionalidade: Observabilidade
  Como pessoa de operação
  Quero métricas protegidas e um id de correlação em todos os logs
  Para investigar um vídeo do upload até o e-mail

  Cenário: /metrics exige token e expõe as métricas HTTP e de negócio
    Quando consulto o /metrics do video-api sem token
    Então o /metrics responde 401
    Quando consulto o /metrics do video-api com o token
    Então vejo o histograma "fiapx_http_request_duration_seconds" da rota "/api/videos"
    E vejo as métricas de negócio do contrato nos 3 serviços

  Cenário: o correlation id atravessa API, worker e notificação
    Dado que estou cadastrado e autenticado
    Quando envio o vídeo corrompido "sample-corrupt.mp4" com um correlation id próprio
    E o vídeo termina com status "FAILED"
    Então os logs do video-api, do video-worker e do notification-service mostram esse correlation id
