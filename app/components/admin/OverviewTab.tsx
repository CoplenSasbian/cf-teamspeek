import { useMemo } from 'react';
import {
  Activity,
  Users,
  DoorOpen,
  Gauge,
  ListChecks,
  AlertTriangle,
} from 'lucide-react';

import { cn, formatBytes, formatNumber } from '~/lib/utils';
import type { RoomMember } from '@shared/types';

export interface OverviewData {
  stats: { roomCount: number; totalMembers: number; registeredUsers: number };
  rooms: Array<{
    id: string;
    name: string;
    memberCount: number;
    maxMembers: number;
    members: RoomMember[];
    trackCount: number;
    createdAt: number;
  }>;
  auditBacklog: number;
  usageNow: Record<string, number>;
  serverTime: number;
}

export function OverviewTab({ data }: { data: OverviewData | null }) {
  if (!data) return <PanelSkeleton />;

  const egress = data.usageNow.sfu_egress_bytes ?? 0;
  const freeEgress = 1000 * 1024 ** 3;

  return (
    <div className="flex flex-col gap-5">
      {/* 关键指标 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={DoorOpen}
          label="活跃房间"
          value={formatNumber(data.stats.roomCount)}
          tone="brand"
        />
        <StatCard
          icon={Users}
          label="在线人数"
          value={formatNumber(data.stats.totalMembers)}
          tone="emerald"
        />
        <StatCard
          icon={Activity}
          label="注册用户"
          value={formatNumber(data.stats.registeredUsers)}
          tone="slate"
        />
        <StatCard
          icon={Gauge}
          label="本月出站"
          value={formatBytes(egress, 1)}
          tone="amber"
        />
      </div>

      {/* 出站额度进度 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-2">
            <Gauge className="h-4 w-4 text-accent" />
            SFU 出站流量（本月累计）
          </h3>
          <span className="font-mono text-xs text-ink-3">
            {formatBytes(egress, 2)} / 1000 GB
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              egress / freeEgress > 0.8
                ? 'bg-down'
                : egress / freeEgress > 0.5
                  ? 'bg-warn/100'
                  : 'bg-up',
            )}
            style={{ width: `${Math.min(100, (egress / freeEgress) * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-ink-3">
          免费额度 1000 GB/月。这是唯一直接对应扣费的指标。
        </p>
      </section>

      {/* 待落库积压 */}
      {data.auditBacklog > 200 && (
        <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            审计缓冲积压 {data.auditBacklog} 条，将在下次定时任务时落库。若持续增长请检查
            cron 配置。
          </span>
        </div>
      )}

      {/* 房间明细 */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink-2">房间明细</h3>
        {data.rooms.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-3">当前没有房间</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.rooms.map((room) => (
              <li key={room.id} className="rounded-xl border border-line-soft bg-surface-2/60 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{room.name}</span>
                  <span className="text-xs text-ink-3">
                    {room.memberCount} / {room.maxMembers} 人 · {room.trackCount} 轨道
                  </span>
                </div>
                {room.members.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {room.members.map((m) => (
                      <span
                        key={m.uid}
                        className="rounded-md bg-surface px-2 py-1 text-xs text-ink-2 ring-1 ring-line"
                      >
                        {m.nickname}
                        {m.role === 'admin' && ' 👑'}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: 'brand' | 'emerald' | 'slate' | 'amber';
}) {
  const tones = {
    brand: 'bg-accent-soft text-accent',
    emerald: 'bg-up/10 text-up',
    slate: 'bg-surface-2 text-ink-2',
    amber: 'bg-warn/10 text-warn',
  };
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className={cn('mb-2.5 inline-flex h-8 w-8 items-center justify-center rounded-lg', tones[tone])}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

export function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-surface-2" />
        ))}
      </div>
      <div className="h-32 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-48 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}

export { ListChecks };
