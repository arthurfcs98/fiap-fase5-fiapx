import { runTopologySetupCli } from '@fiapx/messaging';
import { exitOnBootstrapError } from '@fiapx/observability';
import { SERVICE_NAME } from './config/api.config';

/**
 * One-shot RabbitMQ topology (`node dist/setup-topology.js`): first container of the K8s Job
 * `rabbitmq-init`, with the administrator's `RABBITMQ_URL` (contratos.md, section 2).
 */
runTopologySetupCli({ service: SERVICE_NAME }).catch(
  exitOnBootstrapError('video-api-setup-topology'),
);
