import logoUrl from "@/assets/icon-128.png";
import { DemoSection } from "./DemoSection";
import { CredentialsUi } from "@/options/credentials-ui";
import { DUMMY_CREDENTIALS } from "./fixtures";
import { PopupView } from "@/popup/App";

export default function App() {
  return (
    <div className="max-w-4xl mx-auto py-12 px-6 space-y-10">
      <header className="flex items-center gap-3">
        <img src={logoUrl} alt="DV" className="w-10 h-10 rounded-lg" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            디브이 애드 매니저 — 데모
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Phase 2 시안 모음. 빌드 시 dist/에 포함되지 않습니다.
          </p>
        </div>
      </header>

      <div className="space-y-12">
        <DemoSection title="옵션 F011 · 미등록">
          <CredentialsUi state="empty" onSubmit={(v) => console.log("submit", v)} />
        </DemoSection>

        <DemoSection title="옵션 F011 · 등록됨">
          <CredentialsUi
            state="registered"
            initial={DUMMY_CREDENTIALS}
            onEdit={() => console.log("edit")}
            onDelete={() => console.log("delete")}
          />
        </DemoSection>

        <DemoSection title="옵션 F011 · 등록 실패">
          <CredentialsUi
            state="error"
            initial={DUMMY_CREDENTIALS}
            errorMessage="API 인증 실패 (401). 광고관리자에서 발급받은 secretKey가 맞는지 확인해주세요."
            onCancel={() => console.log("cancel")}
            onSubmit={(v) => console.log("retry", v)}
          />
        </DemoSection>

        <DemoSection title="옵션 F011 · 라이선스 미설정 (잠금)">
          <CredentialsUi state="locked" />
        </DemoSection>

        <DemoSection title="팝업 F012 · 정상" description="라이선스 활성 + API 등록됨 — brand 버튼 0개">
          <PopupView state="ok" />
        </DemoSection>

        <DemoSection title="팝업 F012 · API 미등록" description="brand 1개 (옵션 열기)">
          <PopupView state="no-cred" />
        </DemoSection>

        <DemoSection title="팝업 F012 · 라이선스 미설정" description="empty state, brand 1개">
          <PopupView state="no-license" />
        </DemoSection>
      </div>
    </div>
  );
}
