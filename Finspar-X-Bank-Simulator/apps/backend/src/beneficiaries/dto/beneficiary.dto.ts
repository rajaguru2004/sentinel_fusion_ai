import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsEmail,
  MaxLength,
  Matches,
  IsArray,
} from 'class-validator';

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export class CreateBeneficiaryDto {
  @IsString() @IsNotEmpty() @MaxLength(20) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;

  @IsString() @IsNotEmpty() @MaxLength(35) accountNumber!: string;

  @IsOptional() @Matches(IFSC_REGEX, { message: 'IFSC must match ^[A-Z]{4}0[A-Z0-9]{6}$' }) ifsc?: string;

  @IsOptional() @IsBoolean() isOwnBank?: boolean;

  // Beneficiary Type — at least one rail (validated in service).
  @IsOptional() @IsBoolean() allowIFT?: boolean;
  @IsOptional() @IsBoolean() allowRTGS?: boolean;
  @IsOptional() @IsBoolean() allowNEFT?: boolean;
  @IsOptional() @IsBoolean() allowIMPS?: boolean;

  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() addressLine2?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() pinCode?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;

  // Name resolved from the destination bank ("Fetch Beneficiary").
  @IsOptional() @IsString() nameAsFetched?: string;
}

export class UpdateBeneficiaryDto extends CreateBeneficiaryDto {}

export class FetchNameDto {
  @IsString() @IsNotEmpty() accountNumber!: string;
  @IsOptional() @IsString() ifsc?: string;
}

export class BulkIdsDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}
