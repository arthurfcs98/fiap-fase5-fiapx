# language: pt
Funcionalidade: Isolamento entre usuários e autenticação obrigatória
  Como usuário do FIAP Frames
  Quero que só eu veja os meus vídeos
  Para que os meus arquivos fiquem privados

  Cenário: usuário não vê vídeos de outro usuário
    Dado que a usuária "Ana" enviou um vídeo
    E que o usuário "Bruno" está autenticado
    Quando "Bruno" consulta o vídeo de "Ana"
    Então "Bruno" recebe 404 com o código "V0001"
    E "Bruno" também recebe 404 ao pedir o link de download do vídeo de "Ana"
    E a lista de vídeos de "Bruno" não mostra o vídeo de "Ana"

  Cenário: requisição sem token recebe 401
    Quando consulto a lista de vídeos sem token
    Então recebo 401 com o código "A0003"
    E enviar um vídeo sem token também recebe 401
    E um token adulterado também recebe 401
