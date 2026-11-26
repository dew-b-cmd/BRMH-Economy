# BRMH Economy 자동 갱신

## 설치 / 적용

1. GitHub에서 기존 저장소를 clone하거나 Codex에서 기존 로컬 저장소를 엽니다. 기존 작업을 먼저 commit하고 깨끗한 작업 트리에서 시작합니다.
2. `python <압축해제폴더>/install.py <저장소폴더>`로 사전 검사 후 같은 명령 뒤에 `--apply`를 붙여 적용합니다. 설치기는 기존 HTML/강의 자료를 수정하지 않으며, 기존 자동화 파일이 있거나 원본이 달라졌으면 중단합니다.
3. `python -m unittest discover -s scripts -p 'test_*.py'` 및 `git diff`를 검토하고 자동화 변경 파일과 공개 데이터 스냅숏만 커밋합니다. `.env`, 모델 가중치, `.runtime`은 커밋하지 마세요.
4. [Actions secrets](https://github.com/dew-b-cmd/BRMH-Economy/settings/secrets/actions)에 기존 API 키 `CUSTOMS_SERVICE_KEY`, `OPENDART_API_KEY` 및 연락 이메일 `SEC_CONTACT_EMAIL`을 설정합니다. 채팅이나 소스에 키를 기록하지 마세요.
5. [Pages 설정](https://github.com/dew-b-cmd/BRMH-Economy/settings/pages)의 Source를 GitHub Actions로 변경합니다. Actions의 contents/pages/id-token 권한과 github-pages environment의 배포 허용을 확인합니다.
6. main에 변경사항을 병합하고 [Actions](https://github.com/dew-b-cmd/BRMH-Economy/actions)에서 `Update economy and deploy Pages` → Run workflow를 실행합니다. 첫 실행은 모델 가중치 다운로드가 필요합니다. Force 옵션은 전체 재조회/재추론용입니다.
7. Actions 요약에서 출처별 결과, 모델의 실제 성공, 게시된 JSON 및 화면을 확인합니다. 코드 푸시나 Force 실행의 최종 검증은 필수 출처와 모델이 갱신되고 게시 JSON이 일치해야 통과합니다. 소스 실패 시 공개 화면에는 마지막으로 확인된 데이터와 상태를 표시합니다.

## 동작 및 한계
- 한국시간 07:17, 12:17, 19:17 예정 실행 (GitHub 예약 실행 지연 가능). 월간 지표는 성공 후 20시간 이상 지나면 재조회; 공시는 매 실행; NVDA 종가 해시 변경 시 재추론.
- 기존 ZIP의 Python 수집 모듈, 120봉, 5거래일, 고정 Kronos-small 가중치를 재사용합니다. 거래일표는 2026~2028년만 지원하므로 그 전에 확장해야 합니다.
- 소스별 실패 시 기존 데이터와 성공 시각 보존. 새 종가와 예측 해시가 다르면 예측을 표시하지 않음. 과거 예측은 기존 저장본일 수 있으며 상태로 구분합니다.
- 시장 전체 공시와 정기 브리핑은 기존 스냅숏을 사용합니다. Worker 주소를 설정하면 기업 검색은 SEC 또는 OpenDART에 직접 요청합니다. Worker를 설정하기 전에도 OpenDART 기업 검색을 지원합니다. GitHub Actions가 지난 30일 공식 공시를 수집하며, 화면에 수집 시각과 조회 범위를 표시합니다. 기업 식별용 디렉터리는 약 하루마다 갱신합니다.
- SEC는 티커 또는 CIK, OpenDART는 기업명·6자리 종목코드·8자리 고유번호를 지원합니다. 날짜 범위는 한 번에 최대 366일입니다. 검색 결과의 원문은 각 기관 공식 사이트에서 확인할 수 있습니다.
- 공개 저장소의 표준 GitHub-hosted 러너 무료 사용을 전제로 설계. 모델 다운로드/CPU 추론 시간, Nasdaq의 클라우드 IP 제한, API 키 승인, RSS 및 SEC 접근은 실제 실행으로 확인해야 합니다.
- GITHUB_TOKEN 커밋 후 별도 배포 이벤트에 의존하지 않고 같은 워크플로에서 Pages artifact를 직접 배포합니다.
- 브라우저 JSON 요청은 no-store로 지정하지만 CDN 배포 반영 지연 가능. 최초 배포 후 실제 화면을 반드시 확인하세요.

## 공시 검색 API 배포

1. Cloudflare Wrangler에서 배포 계정으로 로그인하고 `wrangler deploy --config worker/wrangler.toml`을 실행합니다.
2. 같은 Worker의 Secrets에 `OPENDART_API_KEY`와 `SEC_CONTACT_EMAIL`을 등록합니다. 브리핑용 GitHub Actions Secrets는 기존과 같은 용도로 사용합니다.
3. Worker URL을 GitHub Actions 저장소 변수 `DISCLOSURE_API_URL`에 등록합니다. 이후 Pages 워크플로를 실행하면 공개 주소를 배포용 HTML에 연결합니다.
4. `node --test worker/*.test.mjs`로 입력, 권한, 오류 및 재무 분석 단위 테스트를 실행할 수 있습니다.
