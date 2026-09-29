import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Gauge } from 'lucide-react';

import { adminApi } from '~/lib/api';
import { cn, formatBytes, formatNumber } from '~/lib/utils';
import { PanelSkeleton } from './OverviewTab';

interface UsageData {
  series: Record<string, Record<string, number>>;
  live: Record<string, number>;
  freeTier: Record<string, number>;
  days: number;
}

type Range = 7 | 30;

export function UsageTab() {
  const [days, setDays] = useState<Range>(7);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void adminApi
      .usage(days)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [days]);

  if (loading || !data) return <PanelSkeleton />;

  const chartData = Object.entries(data.series)
    .map(([day, metrics]) => ({
      day: day.slice(5), // MM-DD
      mb: Number(((metrics.sfu_egress_bytes ?? 0) / 1024 ** 2).toFixed(2)),
      publishes: metrics.publish_count ?? 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const egressTotal = chartData.reduce((a, b) => a + (b.mb * 1024 ** 2), 0);
  const freeEgress = data.freeTier.sfu_egress_bytes_month ?? 1000 * 1024 ** 3;

  return (
    <div className="flex flex-col gap-5">
      {/* 范围切换 */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-2">
          <Gauge className="h-4 w-4 text-accent" />
          用量看板
        </h3>
        <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition',
                days === d
                  ? 'bg-surface text-ink shadow-sm'
                  : 'text-ink-3 hover:text-ink-2',
              )}
            >
              {d} 天
            </button>
          ))}
        </div>
      </div>

      {/* 免费额度进度条 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h4 className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-3">
          免费额度占用
        </h4>
        <div className="flex flex-col gap-4">
          <QuotaBar
            label="SFU 出站流量"
            used={egressTotal}
            total={freeEgress}
            format={formatBytes}
            note="月度额度，直接对应扣费"
          />
          <QuotaBar
            label="今日 D1 写入"
            used={0}
            total={data.freeTier.d1_writes_day ?? 100_000}
            format={formatNumber}
            note="每日 10 万行，是本项目最紧的瓶颈"
          />
          <QuotaBar
            label="今日 Workers 请求"
            used={0}
            total={data.freeTier.worker_requests_day ?? 100_000}
            format={formatNumber}
            note="每日 10 万次"
          />
        </div>
      </section>

      {/* 折线图 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h4 className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-3">
          出站流量趋势（MB）
        </h4>
        {chartData.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-3">暂无数据</p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                  }}
                  formatter={(value) => [`${String(value ?? 0)} MB`, '出站']}
                />
                <Line
                  type="monotone"
                  dataKey="mb"
                  stroke="#3366ff"
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: '#3366ff' }}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 实时累加器 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-3">
          实时累加器（未落库）
        </h4>
        {Object.keys(data.live).length === 0 ? (
          <p className="text-sm text-ink-3">无待落库数据</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {Object.entries(data.live).map(([metric, value]) => (
              <li key={metric} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs text-ink-3">{metric}</span>
                <span className="tabular-nums font-medium text-ink">
                  {metric.includes('bytes') ? formatBytes(value) : formatNumber(value)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function QuotaBar({
  label,
  used,
  total,
  format,
  note,
}: {
  label: string;
  used: number;
  total: number;
  format: (n: number) => string;
  note?: string;
}) {
  const ratio = total > 0 ? used / total : 0;
  const pct = Math.min(100, ratio * 100);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-2">{label}</span>
        <span className="font-mono text-xs text-ink-3">
          {format(used)} / {format(total)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            ratio > 0.8 ? 'bg-down' : ratio > 0.5 ? 'bg-warn/100' : 'bg-up',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
    </div>
  );
}
