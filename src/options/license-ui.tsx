import { useEffect, useState } from "react";
import {
  loadKey,
  clearKey,
  registerDevice,
  verifyAccess,
} from "@/lib/license";
import { formatDate, reasonMessage } from "@/lib/license-format";
import type { VerifyAccessResult, VerifyReason } from "@/types";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "registering" }
  | { kind: "register_failed"; reason: VerifyReason };

const ORANGE = "#E6783B";

export default function LicenseUi() {
  const [keyInput, setKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyAccessResult | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    void refresh(true);
  }, []);

  async function refresh(initial = false) {
    if (initial) setStatus({ kind: "checking" });
    const k = await loadKey();
    setSavedKey(k);
    if (k) {
      const v = await verifyAccess({ force: true });
      setVerify(v);
    } else {
      setVerify(null);
    }
    setStatus({ kind: "idle" });
  }

  async function handleRegister() {
    const key = keyInput.trim();
    if (!key) return;
    setStatus({ kind: "registering" });
    const result = await registerDevice(key);
    if (!result.ok) {
      setStatus({ kind: "register_failed", reason: result.reason });
      return;
    }
    setKeyInput("");
    await refresh();
  }

  async function handleClear() {
    if (!confirm("등록된 라이선스 키를 해제할까요? 다시 사용하려면 키를 재입력해야 합니다.")) return;
    await clearKey();
    setVerify(null);
    setSavedKey(null);
    setStatus({ kind: "idle" });
  }

  return (
    <section className="bg-white border rounded-lg p-6 mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">라이선스</h2>

      {status.kind === "checking" && (
        <p className="text-sm text-gray-500">상태 확인 중…</p>
      )}

      {status.kind !== "checking" && !savedKey && (
        <RegisterForm
          value={keyInput}
          onChange={setKeyInput}
          onSubmit={handleRegister}
          status={status}
        />
      )}

      {status.kind !== "checking" && savedKey && verify && (
        <RegisteredView
          savedKey={savedKey}
          verify={verify}
          onClear={handleClear}
          onRefresh={() => void refresh(true)}
        />
      )}
    </section>
  );
}

function RegisterForm({
  value,
  onChange,
  onSubmit,
  status,
}: {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  status: Status;
}) {
  const busy = status.kind === "registering";
  const canSubmit = value.trim().length > 0;

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:border-[#E6783B] font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit && !busy) onSubmit();
          }}
        />
        <button
          onClick={onSubmit}
          disabled={!canSubmit || busy}
          className="px-4 py-2 text-sm font-medium rounded text-white disabled:bg-gray-300 transition"
          style={{ background: canSubmit ? ORANGE : undefined }}
        >
          {busy ? "확인 중…" : "등록"}
        </button>
      </div>

      {status.kind === "register_failed" && (
        <p className="mt-2 text-sm text-red-600">
          {reasonMessage(status.reason)}
        </p>
      )}
    </div>
  );
}

function RegisteredView({
  savedKey,
  verify,
  onClear,
  onRefresh,
}: {
  savedKey: string;
  verify: VerifyAccessResult;
  onClear: () => void;
  onRefresh: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-3">
      <Row
        label="키"
        value={
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className={
              revealed
                ? "font-mono text-gray-800 hover:text-[#E6783B] transition cursor-pointer"
                : "font-mono rounded px-2 py-0.5 bg-gray-100 text-gray-100 hover:bg-gray-200 hover:text-gray-200 transition cursor-pointer select-none"
            }
            title={revealed ? "클릭하여 숨기기" : "클릭하여 보기"}
          >
            {savedKey}
          </button>
        }
      />
      <Row
        label="상태"
        value={
          verify.allowed ? (
            <span className="text-green-700 font-medium">활성</span>
          ) : (
            <span className="text-red-600 font-medium">{reasonMessage(verify.reason)}</span>
          )
        }
      />
      {verify.expires_at !== undefined && (
        <Row
          label="만료일"
          value={
            verify.expires_at === null
              ? "무제한 라이선스"
              : formatDate(verify.expires_at)
          }
        />
      )}
      {verify.max_devices !== undefined && (
        <Row
          label="활성 디바이스"
          value={
            verify.max_devices === null
              ? "제한 없음"
              : `${verify.active_devices ?? "?"} / ${verify.max_devices}`
          }
        />
      )}

      <p className="text-xs text-gray-500 !mt-1">
        * 추가 디바이스가 필요한 경우 광고 담당자에게 요청해 주세요
      </p>

      <div className="flex gap-2 pt-3">
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50 transition"
        >
          새로고침
        </button>
        <button
          onClick={onClear}
          className="ml-auto px-3 py-1.5 text-sm rounded border border-red-200 text-red-600 hover:bg-red-50 transition"
        >
          해제
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center text-sm">
      <span className="w-24 text-gray-500">{label}</span>
      <span className={mono ? "font-mono text-gray-800" : "text-gray-800"}>
        {value}
      </span>
    </div>
  );
}

