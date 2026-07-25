export interface AccountBalance {
  id: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  schemeType: string | null;
  currency: string;
  clearBalance: string;
  fundsInClearing: string;
  holdAmount: string;
  fdBalance: string;
  availableBalance: string;
  effectiveAvailable: string;
}

export interface StatementRow {
  id: string;
  date: string;
  valueDate: string;
  description: string;
  refNo: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balanceAfter: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
}

export interface PortfolioRow {
  accountName: string;
  accountNumber: string;
  availableAmount: string;
  currency: string;
  schemeType: string | null;
}

export interface BeneficiaryRow {
  id: string;
  code: string;
  name: string;
  nameAsFetched: string | null;
  accountNumber: string;
  ifsc: string | null;
  isOwnBank: boolean;
  allowIFT: boolean;
  allowRTGS: boolean;
  allowNEFT: boolean;
  allowIMPS: boolean;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DELETED';
  activatedAt: string | null;
  state: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
}
