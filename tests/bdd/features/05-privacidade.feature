# language: pt
Funcionalidade: Privacidade dos dados pessoais (LGPD)
  Como titular dos dados
  Quero consentir, acessar e eliminar os meus dados
  Para exercer os direitos do art. 18 da LGPD

  Cenário: cadastro sem aceite da política de privacidade é recusado
    Quando tento me cadastrar sem aceitar a política de privacidade
    Então o cadastro é recusado com status 400 e o código "X0001"

  Cenário: cadastros simultâneos com o mesmo e-mail criam uma única conta
    Quando 5 cadastros com o mesmo e-mail chegam ao mesmo tempo
    Então só um é aceito com status 201 e os demais recebem 409 com o código "A0002"

  Cenário: usuário exporta os próprios dados
    Dado que estou cadastrado e autenticado
    E que enviei um vídeo que já foi processado
    Quando peço a exportação dos meus dados
    Então recebo os meus dados cadastrais sem o hash da senha
    E a exportação lista o vídeo com o histórico de status

  Cenário: usuário exclui a conta e os dados são apagados ou anonimizados
    Dado que estou cadastrado e autenticado
    E que enviei um vídeo que já foi processado
    E que recebi o e-mail de vídeo processado
    Quando tento excluir a conta com a senha errada
    Então a exclusão é recusada com status 400 e o código "A0004"
    Quando excluo a conta com a senha correta
    Então a exclusão responde 204
    E o meu token antigo passa a receber 401
    E não resta nenhum registro meu no banco do video-api
    E não resta nenhum arquivo meu nos buckets
    E as minhas notificações ficam anonimizadas no notification-service
