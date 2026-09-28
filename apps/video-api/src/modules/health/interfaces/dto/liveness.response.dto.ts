import { ApiProperty } from '@nestjs/swagger';

export class LivenessResponseDto {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ example: 'video-api' })
  service!: string;

  @ApiProperty({
    example: '3f2c1a9',
    description: 'Revisão de build da imagem (SHA do commit); "dev" fora do CI',
  })
  version!: string;
}
