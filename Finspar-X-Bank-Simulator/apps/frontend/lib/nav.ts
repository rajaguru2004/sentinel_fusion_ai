import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Send,
  User,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Radar,
} from 'lucide-react';

export interface NavChild {
  label: string;
  href: string;
}

export interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  children?: NavChild[];
}

/** Navigation IA — BANK_SIMULATOR_SPEC.md §7 (single shell). */
export const NAV: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  {
    label: 'Account',
    icon: Wallet,
    children: [
      { label: 'Account Balance', href: '/account/balance' },
      { label: 'Account Statement', href: '/account/statement' },
      { label: 'Mini Statement', href: '/account/mini-statement' },
      { label: 'Portfolio Statement', href: '/account/portfolio' },
    ],
  },
  {
    label: 'Beneficiary',
    icon: Users,
    children: [
      { label: 'Beneficiary Maintenance', href: '/beneficiary/maintenance' },
      { label: 'Activate Beneficiary', href: '/beneficiary/activate' },
      { label: 'Delete Beneficiary', href: '/beneficiary/delete' },
    ],
  },
  {
    label: 'Payments',
    icon: Send,
    children: [
      { label: 'Initiate Payments', href: '/payments/initiate' },
      { label: 'Modify Payments', href: '/payments/modify' },
    ],
  },
  { label: 'Profile', href: '/profile', icon: User },
  { label: 'Change Password', href: '/change-password', icon: KeyRound },
  { label: 'Transaction Password', href: '/transaction-password', icon: KeyRound },
  {
    label: 'Dispute Resolution',
    icon: ShieldAlert,
    children: [
      { label: 'Report Fraudulent Transaction', href: '/disputes/report' },
      { label: 'Track Request', href: '/disputes/track' },
      { label: 'Grievance Redressal', href: '/disputes/grievance' },
    ],
  },
  { label: 'Analyst Dashboard', href: '/analyst', icon: ShieldCheck },
  // The Intrusion and Future-Proofing watchers have no banking flow to ride on
  // (the bank emits only financial/behaviour events), so they get their own
  // console alongside the Command Center fusion view.
  { label: 'Sentinel Console', href: '/sentinel', icon: Radar },
];
