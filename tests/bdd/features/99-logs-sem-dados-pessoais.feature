# language: pt
Funcionalidade: Logs sem dados pessoais (LGPD)
  Como encarregado de dados
  Quero que os logs tenham só identificadores
  Para que um vazamento de logs não exponha os usuários

  # Roda por último: confere os logs gerados por todos os cenários anteriores.
  Cenário: os logs do stack não contêm e-mail, nome, nome de arquivo nem link assinado
    Quando leio os logs de todos os serviços do stack
    Então nenhum e-mail de usuário aparece nos logs
    E nenhum nome de usuário aparece nos logs
    E nenhum nome de arquivo enviado aparece nos logs
    E nenhuma assinatura de link de download aparece nos logs
