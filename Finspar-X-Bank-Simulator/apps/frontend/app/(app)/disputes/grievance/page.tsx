'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';

const CATEGORIES = ['Transaction dispute', 'Service quality', 'Channel issue', 'Other'];

export default function GrievancePage() {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [detail, setDetail] = useState('');
  const [result, setResult] = useState<{ trackingRef: string } | null>(null);

  const submit = async (): Promise<void> => {
    if (!detail) return void toast.error('Describe your grievance');
    try {
      const { data } = await api.post('/disputes/grievance', { category, detail });
      setResult(data);
      toast.success('Grievance registered');
    } catch (e) { toast.error(apiError(e)); }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Grievance Redressal" />
      {result ? (
        <Card>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-risk-low" />
            <p className="font-medium text-text">Grievance registered</p>
            <p className="tabular text-sm text-text-muted">Tracking Reference: {result.trackingRef}</p>
          </div>
        </Card>
      ) : (
        <Card title="Raise a grievance">
          <div className="space-y-4">
            <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}
              options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <div>
              <label className="text-sm font-medium text-text">Detail</label>
              <textarea value={detail} onChange={(e) => setDetail(e.target.value)}
                className="mt-1.5 h-28 w-full rounded-[var(--radius-input)] border border-border bg-surface p-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <Button onClick={submit}>Submit</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
