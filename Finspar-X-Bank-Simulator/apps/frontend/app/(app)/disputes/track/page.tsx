'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { formatDateTimeDMY } from '@/lib/format';

export default function TrackRequestPage() {
  const [ref, setRef] = useState('');
  const [result, setResult] = useState<any>(null);

  const search = async (): Promise<void> => {
    try {
      const { data } = await api.get(`/disputes/track?trackingRef=${ref}`);
      setResult(data);
    } catch (e) {
      setResult(null);
      toast.error(apiError(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Track Request" />
      <Card title="Search">
        <div className="flex items-end gap-3">
          <div className="flex-1"><Input label="Tracking Ref No." value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <Button onClick={search}><Search className="h-4 w-4" /> Search</Button>
          <Button variant="ghost" onClick={() => { setRef(''); setResult(null); }}>Clear</Button>
        </div>
      </Card>

      {result && (
        <Card title={`Request ${result.trackingRef}`} className="mt-6">
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div><p className="text-text-muted">Request Date</p><p className="tabular font-medium text-text">{formatDateTimeDMY(result.requestDate)}</p></div>
            <div><p className="text-text-muted">Type</p><p className="font-medium text-text">{result.fraudType}</p></div>
            <div><p className="text-text-muted">Status</p><Badge tone={result.status === 'RESOLVED' ? 'success' : 'warning'}>{result.status}</Badge></div>
            <div><p className="text-text-muted">Last Updated</p><p className="tabular font-medium text-text">{formatDateTimeDMY(result.lastUpdated)}</p></div>
          </div>
          {result.updates?.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <p className="text-sm font-medium text-text">Updates</p>
              {result.updates.map((u: any, i: number) => (
                <div key={i} className="text-sm">
                  <span className="tabular text-xs text-text-muted">{formatDateTimeDMY(u.date)}</span>
                  <p className="text-text">{u.body}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
