import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  // CAPTCHA is validated on the frontend / stubbed here (no real captcha service).
  @IsOptional()
  @IsString()
  captcha?: string;

  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @IsOptional()
  @IsBoolean()
  virtualKeyboard?: boolean;
}
