import type { VerifyReason } from "@/types";

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function maskKey(k: string): string {
  if (k.length <= 12) return k;
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

export function reasonMessage(reason: VerifyReason): string {
  switch (reason) {
    case "ok":
      return "정상";
    case "invalid_key":
      return "유효하지 않은 키입니다.";
    case "inactive":
      return "비활성화된 키입니다. 운영자에게 문의하세요.";
    case "expired":
      return "만료된 키입니다.";
    case "device_kicked":
      return "다른 디바이스에서 등록되어 이 디바이스 세션이 해제되었습니다. 키를 다시 등록하세요.";
    case "no_key":
      return "등록된 키가 없습니다.";
    case "network_error":
      return "서버 연결에 실패했습니다. 잠시 후 다시 시도하세요.";
  }
}
