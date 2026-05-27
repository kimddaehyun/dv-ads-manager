/**
 * auth-ui.tsx — 로그인 / 회원가입 / 비밀번호 찾기 / 온보딩 UI 골격.
 *
 * 자매 프로젝트(디브이 SEO 매니저)의 license-ui.tsx 디자인을 1:1로 옮긴 비활성 골격.
 * 모든 제출 핸들러는 stub (console.log 후 noop). 옵션 페이지(Options.tsx)에는 아직
 * 마운트하지 않음 — 라이선스 시스템 재도입 시 활성화 예정.
 *
 * 사용 예시 (활성화 시):
 *   <AuthCard onSuccess={() => location.reload()} />
 *
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Tabs / Checkbox / RadioCard.
 */

import { useState } from "react";
import iconUrl from "@/assets/icon-128.png";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Tabs } from "@/components/Tabs";
import { Checkbox } from "@/components/Checkbox";
import { RadioCard } from "@/components/RadioCard";
import { GoogleButton } from "@/components/GoogleButton";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-ads-legal/";
const BRAND = "#E6783B";

interface AuthCardProps {
  onSuccess?: () => void;
}

// ============================================================
// Top-level — 로그인/회원가입 카드 (max-w-md, AuthForm wrapper)
// ============================================================

export function AuthCard({ onSuccess }: AuthCardProps) {
  return (
    <section className="mb-6 flex justify-center">
      <Card padding="auth" className="w-full max-w-md overflow-hidden">
        <div className="flex items-center gap-3">
          <img src={iconUrl} alt="디브이 애드 매니저" className="h-11 w-11 rounded-lg flex-shrink-0" />
          <h1 className="text-xl font-bold text-gray-900">디브이 애드 매니저</h1>
        </div>
        <div className="mt-7">
          <AuthForm onSuccess={onSuccess} />
        </div>
      </Card>
    </section>
  );
}

// ============================================================
// AuthForm — 탭(로그인/회원가입) + 입력 폼 + Google + 비번찾기 진입
// ============================================================

type AuthMode = "sign-in" | "sign-up";

function AuthForm({ onSuccess }: { onSuccess?: () => void }) {
  const [view, setView] = useState<"auth" | "forgot">("auth");
  const [mode, setMode] = useState<AuthMode>("sign-in");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [isPartner, setIsPartner] = useState<boolean | null>(null);
  const [company, setCompany] = useState("");
  const [contact, setContact] = useState("");
  const [storeLink, setStoreLink] = useState("");
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSignUp = mode === "sign-up";
  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (!isSignUp || isPartner !== null) &&
    (!isSignUp || company.trim().length > 0) &&
    (!isSignUp || contact.trim().length > 0) &&
    (!isSignUp || agreedPrivacy);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setErr(null);
    // STUB: 라이선스 시스템 재도입 시 signIn/signUp 호출로 교체.
    console.info("[auth-ui stub] submit", {
      mode,
      email: email.trim(),
      isPartner,
      company: company.trim(),
      contact: contact.trim(),
      storeLink: storeLink.trim(),
    });
    setTimeout(() => {
      setBusy(false);
      setErr("로그인 시스템은 현재 비활성화되어 있습니다. (UI 미리보기)");
      onSuccess?.();
    }, 400);
  }

  function handleGoogle() {
    if (googleBusy) return;
    setGoogleBusy(true);
    setErr(null);
    console.info("[auth-ui stub] google sign-in");
    setTimeout(() => {
      setGoogleBusy(false);
      setErr("Google 로그인은 현재 비활성화되어 있습니다. (UI 미리보기)");
    }, 400);
  }

  if (view === "forgot") {
    return (
      <ForgotPasswordForm
        initialEmail={email}
        onCancel={() => setView("auth")}
        onSuccess={onSuccess}
      />
    );
  }

  return (
    <div className="w-full flex flex-col gap-5">
      <Tabs
        value={mode}
        options={[
          { value: "sign-in", label: "로그인" },
          { value: "sign-up", label: "회원가입" },
        ]}
        onChange={(v) => {
          setMode(v);
          setErr(null);
        }}
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          type="email"
          value={email}
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          placeholder="이메일"
          required
        />
        <Input
          type="password"
          value={password}
          autoComplete={isSignUp ? "new-password" : "current-password"}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
          required
          minLength={6}
        />

        {!isSignUp && (
          <Checkbox
            checked={keepSignedIn}
            onChange={setKeepSignedIn}
            className="-mt-1 pb-2 self-start"
          >
            로그인 상태 유지
          </Checkbox>
        )}

        {isSignUp && (
          <>
            <div className="pt-1">
              <p className="text-sm font-medium text-gray-800 mb-2">
                디브이 파트너사이신가요?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <RadioCard
                  name="partner"
                  checked={isPartner === true}
                  onChange={() => setIsPartner(true)}
                  title="파트너사"
                  description="전용 혜택 적용하기"
                />
                <RadioCard
                  name="partner"
                  checked={isPartner === false}
                  onChange={() => setIsPartner(false)}
                  title="일반 사용자"
                  description="무료로 시작하기"
                />
              </div>
            </div>

            {isPartner !== null && (
              <>
                <Field label="업체명" required variant="compact">
                  <Input
                    type="text"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="디브이컴퍼니"
                    required
                  />
                </Field>
                <Field label="연락처" required variant="compact">
                  <Input
                    type="text"
                    value={contact}
                    onChange={(e) => setContact(formatPhone(e.target.value))}
                    placeholder="010-0000-0000"
                    required
                  />
                </Field>
                <Field label="스토어링크" variant="compact">
                  <Input
                    type="url"
                    value={storeLink}
                    onChange={(e) => setStoreLink(e.target.value)}
                    placeholder="https://smartstore.naver.com/..."
                  />
                </Field>
                <Checkbox
                  checked={agreedPrivacy}
                  onChange={setAgreedPrivacy}
                  className="pt-1"
                >
                  <span>
                    <span className="text-brand">(필수)</span> 개인정보 수집·이용에 동의합니다.{" "}
                    <a
                      href={PRIVACY_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-brand"
                    >
                      전체 보기 ↗
                    </a>
                  </span>
                </Checkbox>
              </>
            )}
          </>
        )}

        {err && <ErrorBox message={err} />}

        <Button
          type="submit"
          variant="brand"
          size="lg"
          block
          disabled={!canSubmit || busy}
          className="mt-1"
        >
          {busy ? "처리 중…" : isSignUp ? "가입하기" : "로그인"}
        </Button>

        {!isSignUp && (
          <>
            <GoogleButton
              onClick={handleGoogle}
              disabled={googleBusy}
              label={googleBusy ? "Google 인증 중…" : "Google로 로그인"}
            />
            <button
              type="button"
              onClick={() => {
                setView("forgot");
                setErr(null);
              }}
              className="mt-1 text-xs text-gray-500 hover:text-gray-700 self-center"
            >
              비밀번호를 잊으셨나요?{" "}
              <span className="underline" style={{ color: BRAND }}>
                비밀번호 찾기
              </span>
            </button>
          </>
        )}
      </form>
    </div>
  );
}

// ============================================================
// 비밀번호 재설정 (OTP 코드 방식) — UI 골격
// ============================================================

function ForgotPasswordForm({
  initialEmail,
  onCancel,
  onSuccess,
}: {
  initialEmail: string;
  onCancel: () => void;
  onSuccess?: () => void;
}) {
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState(initialEmail);
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    if (busy || email.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    console.info("[auth-ui stub] sendPasswordReset", { email: email.trim() });
    setTimeout(() => {
      setBusy(false);
      setInfo("인증 코드를 메일로 보냈습니다. (UI 미리보기)");
      setStep("verify");
    }, 300);
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (newPassword.length < 6) {
      setErr("비밀번호는 최소 6자 이상이어야 합니다.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErr("새 비밀번호가 일치하지 않습니다.");
      return;
    }
    setBusy(true);
    setErr(null);
    console.info("[auth-ui stub] verifyPasswordReset", { email: email.trim(), otp: otp.trim() });
    setTimeout(() => {
      setBusy(false);
      setErr("비밀번호 재설정은 현재 비활성화되어 있습니다. (UI 미리보기)");
      onSuccess?.();
    }, 300);
  }

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-900">비밀번호 재설정</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          ← 로그인으로
        </button>
      </div>

      {step === "request" ? (
        <form onSubmit={handleRequest} className="flex flex-col gap-3">
          <p className="text-xs text-gray-600">
            가입하신 이메일을 입력하시면 6자리 인증 코드를 보내드립니다.
          </p>
          <Input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="이메일"
            required
          />
          {err && <ErrorBox message={err} />}
          <Button
            type="submit"
            variant="brand"
            size="lg"
            block
            disabled={busy || email.trim().length === 0}
            className="mt-1"
          >
            {busy ? "처리 중…" : "인증 코드 받기"}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleVerify} className="flex flex-col gap-3">
          <p className="text-xs text-gray-600">
            <span className="font-medium text-gray-800">{email}</span> 으로 보낸 6자리 코드와<br />
            새로 사용할 비밀번호를 입력해 주세요.
          </p>
          <Input
            type="text"
            inputMode="numeric"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            placeholder="6자리 인증 코드"
            required
            minLength={6}
            maxLength={6}
            className="tracking-widest"
          />
          <Input
            type="password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="새 비밀번호 (6자 이상)"
            required
            minLength={6}
          />
          <Input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="새 비밀번호 확인"
            required
            minLength={6}
          />
          {info && !err && (
            <div className="text-sm bg-brand/10 text-gray-800 rounded-lg px-3 py-2">
              {info}
            </div>
          )}
          {err && <ErrorBox message={err} />}
          <Button
            type="submit"
            variant="brand"
            size="lg"
            block
            disabled={busy || otp.length < 6 || newPassword.length < 6}
            className="mt-1"
          >
            {busy ? "처리 중…" : "비밀번호 변경"}
          </Button>
        </form>
      )}
    </div>
  );
}

// ============================================================
// 헬퍼
// ============================================================

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2 whitespace-pre-line break-keep">
      {message}
    </div>
  );
}

function formatPhone(raw: string): string {
  if (/[^\d\s-]/.test(raw)) return raw;
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
