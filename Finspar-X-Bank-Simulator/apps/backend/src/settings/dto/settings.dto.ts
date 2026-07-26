import { RiskLevel } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

/**
 * Every field optional — the Settings page sends a full object, but a partial
 * PATCH from a script is equally valid and only touches what it names.
 */
export class UpdateSettingsDto {
  // --- 1. Risk-alert email ---
  @IsOptional() @IsBoolean() alertEnabled?: boolean;
  @IsOptional() @IsEnum(RiskLevel) alertMinLevel?: RiskLevel;

  // --- 2. Payment blocking ---
  @IsOptional() @IsBoolean() blockEnabled?: boolean;
  @IsOptional() @IsEnum(RiskLevel) blockMinLevel?: RiskLevel;

  // --- 3. Per-transaction limit / cut-off ---
  /** Rupees, converted to paise on the way in. */
  @IsOptional() @IsNumber() @IsPositive() perTxnLimit?: number;
  @IsOptional() @IsBoolean() cutoffEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) cutoffHour?: number;
  @IsOptional() @IsInt() @Min(0) @Max(59) cutoffMinute?: number;
}
