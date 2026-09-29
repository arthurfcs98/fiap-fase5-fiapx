import { getMetadataArgsStorage } from 'typeorm';
import { NotificationOrmEntity } from './notification.orm-entity';

/** The mapping must match the migration (contratos.md, sections 6 and 12). */
describe('NotificationOrmEntity', () => {
  const storage = getMetadataArgsStorage();
  const columns = storage.columns.filter((column) => column.target === NotificationOrmEntity);

  it('maps the notifications table', () => {
    expect(storage.tables.find((table) => table.target === NotificationOrmEntity)?.name).toBe(
      'notifications',
    );
  });

  it('maps every column of the contract with its database name', () => {
    const names = columns.map((column) => column.options.name ?? column.propertyName);
    expect(names).toEqual([
      'id',
      'dedup_key',
      'user_id',
      'type',
      'recipient',
      'subject',
      'status',
      'attempts',
      'provider_message_id',
      'last_error',
      'payload',
      'created_at',
      'sent_at',
    ]);
  });

  it('declares ix_notifications_user and the database default of created_at', () => {
    const index = storage.indices.find((entry) => entry.target === NotificationOrmEntity);
    expect(index?.name).toBe('ix_notifications_user');

    const createdAt = columns.find((column) => column.propertyName === 'createdAt');
    const defaultValue = createdAt?.options.default as () => string;
    expect(defaultValue()).toBe('now()');
  });
});
