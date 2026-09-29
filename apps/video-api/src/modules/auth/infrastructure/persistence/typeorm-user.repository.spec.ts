import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { aUser, USER_ID } from '../../../../../test/support/fakes';
import { EmailAlreadyRegisteredError } from '../../domain/user.repository';
import { TypeOrmUserRepository, USERS_EMAIL_CONSTRAINT } from './typeorm-user.repository';
import { UserOrmEntity } from './user.orm-entity';

function setup() {
  const repository = {
    findOne: jest.fn(),
    insert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    find: jest.fn(),
  };
  const manager = { getRepository: jest.fn(() => repository) } as unknown as EntityManager;
  return { repository, manager, users: new TypeOrmUserRepository(manager) };
}

const entity = () => Object.assign(new UserOrmEntity(), aUser());

describe('TypeOrmUserRepository', () => {
  it('maps the entity to the domain on reads (by id, by e-mail and locked)', async () => {
    const { repository, users, manager } = setup();
    repository.findOne.mockResolvedValue(entity());

    await expect(users.findById(USER_ID)).resolves.toEqual(aUser());
    await expect(users.findByEmail('ana@example.com')).resolves.toEqual(aUser());
    await expect(users.lockById(USER_ID)).resolves.toEqual(aUser());

    expect(manager.getRepository).toHaveBeenCalledWith(UserOrmEntity);
    expect(repository.findOne).toHaveBeenNthCalledWith(1, { where: { id: USER_ID } });
    expect(repository.findOne).toHaveBeenNthCalledWith(2, { where: { email: 'ana@example.com' } });
    expect(repository.findOne).toHaveBeenNthCalledWith(3, {
      where: { id: USER_ID },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('returns null when not found', async () => {
    const { repository, users } = setup();
    repository.findOne.mockResolvedValue(null);
    await expect(users.findById(USER_ID)).resolves.toBeNull();
  });

  it('inserts, translating the e-mail unique violation', async () => {
    const { repository, users } = setup();
    await users.insert(aUser());
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ id: USER_ID }));

    repository.insert.mockRejectedValueOnce({
      driverError: { code: '23505', constraint: USERS_EMAIL_CONSTRAINT },
    });
    await expect(users.insert(aUser())).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);

    repository.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(users.insert(aUser())).rejects.toThrow('db down');
  });

  it('deletes by id and resolves which ids still exist', async () => {
    const { repository, users } = setup();
    await users.deleteById(USER_ID);
    expect(repository.delete).toHaveBeenCalledWith({ id: USER_ID });

    await expect(users.existingIds([])).resolves.toEqual(new Set());
    repository.find.mockResolvedValue([{ id: USER_ID }]);
    await expect(users.existingIds([USER_ID, 'other'])).resolves.toEqual(new Set([USER_ID]));
    expect(repository.find).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: In([USER_ID, 'other']) },
    });
  });
});
