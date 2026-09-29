# language: pt
Funcionalidade: Retenção do zip (LGPD)
  Como FIAP X
  Quero apagar os arquivos .zip depois do prazo de retenção
  Para não guardar dados pessoais além do necessário

  # Precisa do stack com retenção curta (make test-bdd sobe com ZIP_RETENTION_DAYS=0.0005,
  # cerca de 43 s, e DATA_RETENTION_INTERVAL_S=10). Com o padrão de 7 dias o cenário é pulado.
  Cenário: zip expira depois do prazo de retenção
    Dado que o stack está com um prazo de retenção de zip curto
    E que estou cadastrado e autenticado
    E que enviei um vídeo que já foi processado
    Quando o prazo de retenção do zip passa
    Então o vídeo fica marcado como expirado
    E o link de download responde 410 com o código "V0006"
    E o zip é apagado do bucket
