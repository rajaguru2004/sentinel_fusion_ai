import { IsString, IsNotEmpty, IsOptional, IsEmail, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class ChangeTxnPasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class UpdateProfileDto {
  // Login password confirms the change (mobile/email is where OTPs go).
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
