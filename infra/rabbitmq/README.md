# RabbitMQ (compose)

`enabled_plugins` é montado em `/etc/rabbitmq/enabled_plugins` no compose (cópia idêntica em
`infra/k8s/base/data/rabbitmq/enabled_plugins`, conferida pelo `infra/k8s/scripts/validate.sh`).

Além dos plugins da imagem `-management` (`rabbitmq_management`, `rabbitmq_prometheus`), liga o
**shovel** e a sua página no management (`rabbitmq_shovel`, `rabbitmq_shovel_management`): é o
que habilita o botão **"Move messages"** na página de uma fila, usado no redrive das DLQs
(`docs/observabilidade.md`, runbook do `FiapxDlqNotEmpty`). O shovel move com `ack-mode`
`on-confirm` (nada se perde no caminho), e a mensagem movida de uma DLQ volta com um ciclo novo de
retries (o consumidor zera o `x-retry-count` de mensagens vindas de dead-letter; contratos.md,
seção 2).
