# language: pt
Funcionalidade: Falha no processamento com aviso por e-mail
  Como usuário do FIAP Frames
  Quero ser avisado por e-mail quando o meu vídeo não puder ser processado
  Para saber que preciso enviar outro arquivo

  Cenário: vídeo corrompido termina em FALHOU e usuário recebe e-mail
    Dado que estou cadastrado e autenticado
    Quando envio o vídeo corrompido "sample-corrupt.mp4" com um correlation id próprio
    Então a API aceita o envio com status 202 e o vídeo fica "QUEUED"
    E o vídeo termina em FALHOU com status "FAILED" e o código "P0001"
    E o vídeo original é apagado do storage
    E eu recebo um e-mail avisando que o vídeo não pôde ser processado
    E o e-mail traz o mesmo correlation id do envio
    E o download do zip é recusado com status 409 e o código "V0004"
