# language: pt
Funcionalidade: Pico de uploads sem perder requisições
  Como FIAP X
  Quero que picos de envio sejam absorvidos pela fila e pelos workers
  Para que nenhuma requisição se perca

  Cenário: 15 uploads simultâneos são todos aceitos e processados por 2 ou mais workers
    Dado que há pelo menos 2 workers em execução
    E que estou cadastrado e autenticado
    Quando envio 15 vídeos ao mesmo tempo
    Então todas as 15 requisições são aceitas com status 202
    E todos os 15 vídeos terminam com status "COMPLETED"
    E pelo menos 2 workers diferentes processaram vídeos
    E nenhuma mensagem foi para as filas de dead-letter
    E o outbox do video-api não tem eventos pendentes
