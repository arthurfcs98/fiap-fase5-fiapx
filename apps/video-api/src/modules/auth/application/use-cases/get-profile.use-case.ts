import { AuthErrors } from '@fiapx/common';
import { Inject, Injectable } from '@nestjs/common';
import type { UserView } from '../../domain/user';
import { toUserView } from '../../domain/user';
import type { UserRepository } from '../../domain/user.repository';
import { USER_REPOSITORY } from '../../domain/user.repository';

/** `GET /api/auth/me`. */
@Injectable()
export class GetProfileUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(userId: string): Promise<UserView> {
    const user = await this.users.findById(userId);
    // The JWT strategy already checks that the user exists; this covers a deletion in between.
    if (!user) throw AuthErrors.UNAUTHORIZED();
    return toUserView(user);
  }
}
