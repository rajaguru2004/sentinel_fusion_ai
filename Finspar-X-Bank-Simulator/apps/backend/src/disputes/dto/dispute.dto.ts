import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class ReportFraudDto {
  @IsString() @IsNotEmpty() applicationName!: string;
  @IsString() @IsNotEmpty() accountNumber!: string;
  @IsString() @IsNotEmpty() transactionRef!: string;
  @IsString() @IsOptional() currency?: string;
  @IsNumber() amount!: number; // rupees
  @IsString() @IsNotEmpty() fraudType!: string;
  @IsString() @IsNotEmpty() transactionDate!: string;
  @IsString() @IsNotEmpty() additionalDetail!: string;
}

export class GrievanceDto {
  @IsString() @IsNotEmpty() category!: string;
  @IsString() @IsNotEmpty() detail!: string;
}
