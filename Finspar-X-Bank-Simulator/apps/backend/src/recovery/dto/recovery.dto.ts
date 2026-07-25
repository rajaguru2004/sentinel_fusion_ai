import { IsString, IsNotEmpty, IsOptional, IsEmail, MinLength, IsIn } from 'class-validator';

export class ForgotUserIdDto {
  @IsString() @IsNotEmpty() customerId!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() mobile?: string;
}

export class ForgotPasswordRequestDto {
  @IsString() @IsNotEmpty() customerId!: string;
  @IsString() @IsNotEmpty() userId!: string;
  @IsOptional() @IsIn(['PASSWORD_RESET', 'TXN_PASSWORD']) purpose?: 'PASSWORD_RESET' | 'TXN_PASSWORD';
}

export class ResetPasswordDto {
  @IsString() @IsNotEmpty() requestId!: string;
  @IsString() @IsNotEmpty() code!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

export class UnlockRequestDto {
  @IsString() @IsNotEmpty() customerId!: string;
  @IsString() @IsNotEmpty() userId!: string;
}

export class OtpVerifyDto {
  @IsString() @IsNotEmpty() requestId!: string;
  @IsString() @IsNotEmpty() code!: string;
}

export class ResendDto {
  @IsString() @IsNotEmpty() requestId!: string;
}
