# 사내 TODO 리스트

Supabase(DB·인증·스토리지)와 정적 웹페이지로 만든 팀용 할 일 관리 앱입니다.
빌드 과정 없이 **GitHub Pages**에 그대로 올려 사용할 수 있습니다.

## 주요 기능

- **로그인 / 회원가입 / 비밀번호 재설정** (Supabase Auth, 이메일 + 비밀번호)
- **프로젝트**: 개인(비공개) · 팀 · 전사 공개 범위, 보관 / 삭제
- **할 일**: 상태(할 일·진행 중·완료·취소), 우선순위, 마감일, 하위 작업(1단계), 검색 / 필터 / 정렬
- **담당자 · 라벨**: 팀원 배정, 전사 공통 라벨과 팀 라벨
- **댓글 · 첨부파일**(최대 50MB, 비공개 스토리지) · **활동 기록**(DB 트리거로 자동 기록)
- **휴지통**: 소프트 삭제 후 복구 또는 영구 삭제
- **내 할 일**: 나에게 배정된 모든 할 일, 오늘 마감 / 기한 지남 요약
- **팀 · 구성원**: 팀 생성(관리자), 팀원 추가·팀장 지정(팀장·관리자), 관리자의 권한 / 재직 상태 변경

권한은 모두 DB의 RLS 정책이 지키며, 화면은 권한에 맞춰 버튼을 보이거나 숨깁니다.

## 파일 구성

```
index.html   화면 뼈대
style.css    스타일
app.js       앱 로직 (supabase-js v2를 CDN에서 불러옴)
config.js    Supabase 프로젝트 URL과 Publishable key
.nojekyll    GitHub Pages가 Jekyll 처리를 건너뛰도록 하는 빈 파일
```

## 1. Supabase 준비

1. **SQL 실행**: `todo_schema_all.sql`을 SQL Editor에서 한 번 실행합니다. (이미 했다면 건너뜁니다.)
2. **인증 URL 설정**: Authentication → URL Configuration
   - **Site URL**: `https://<GitHub아이디>.github.io/<저장소이름>/`
   - **Redirect URLs**에도 같은 주소를 추가합니다. (로컬에서 테스트한다면 `http://localhost:8000/`도 추가)
   - 이 설정이 없으면 가입 확인 메일이나 비밀번호 재설정 링크가 localhost로 연결됩니다.
3. **첫 관리자 지정**: 앱에서 회원가입한 뒤 SQL Editor에서 실행합니다.
   ```sql
   update public.profiles set role = 'admin' where email = '관리자@회사.com';
   ```
   이후의 권한 변경은 앱의 **팀 · 구성원** 화면에서 할 수 있습니다.
4. (선택) 사내 전용으로 쓰려면 Authentication → Providers → Email에서 가입 정책을 조정하거나,
   **Allow new users to sign up**을 끄고 관리자가 사용자를 초대하는 방식으로 운영하세요.

## 2. GitHub Pages 배포

1. GitHub에서 새 저장소를 만듭니다. (예: `todo`)
2. 이 폴더의 파일을 모두 저장소 루트에 올립니다. (`.nojekyll` 포함)
   ```bash
   git init
   git add .
   git commit -m "사내 TODO 리스트"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main**, 폴더 **/(root)** → Save
4. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/`에서 접속할 수 있습니다.

## 로컬에서 실행

ES 모듈을 사용하므로 파일을 더블클릭(`file://`)하면 동작하지 않습니다. 간단한 웹 서버로 여세요.

```bash
python3 -m http.server 8000
# 또는
npx serve .
```

## 참고

- `config.js`의 **Publishable key**(`sb_publishable_...`)는 브라우저에 공개되어도 되는 키입니다.
  **secret key / service_role key는 절대 넣지 마세요.**
- 프로젝트나 할 일을 영구 삭제하면 DB의 첨부 정보는 함께 삭제되지만, 스토리지의 실제 파일은 남습니다.
  필요하면 Supabase 대시보드의 Storage에서 정리하세요.
- 퇴사자는 계정을 삭제하지 말고 **팀 · 구성원** 화면에서 ‘재직’ 체크를 해제하세요(로그인 차단, 기록 보존).
