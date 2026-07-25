import { IsString, IsNotEmpty, IsOptional, IsNumber, IsPositive, MaxLength, IsIn } from 'class-validator';

export class InitiatePaymentDto {
  @IsString() @IsNotEmpty() @MaxLength(35) custRefNo!: string;
  @IsNumber() @IsPositive() amount!: number; // rupees
  @IsString() @IsNotEmpty() debitAccountId!: string;
  @IsString() @IsNotEmpty() beneficiaryId!: string;
  @IsString() @IsIn(['IFT', 'IMPS', 'NEFT', 'RTGS']) rail!: 'IFT' | 'IMPS' | 'NEFT' | 'RTGS';
  @IsOptional() @IsString() @IsIn(['IFSC_ACCOUNT', 'MMID']) transferMode?: 'IFSC_ACCOUNT' | 'MMID';
  @IsOptional() @IsString() remarks?: string;
}

export class UpdatePaymentDto {
  @IsOptional() @IsNumber() @IsPositive() amount?: number; // rupees
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(35) custRefNo?: string;
  @IsOptional() @IsString() @MaxLength(140) remarks?: string;
}

export class SubmitPaymentDto {
  @IsString() @IsNotEmpty() txnPassword!: string;
  @IsString() @IsNotEmpty() otpRequestId!: string;
  @IsString() @IsNotEmpty() code!: string;
}
