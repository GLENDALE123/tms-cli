# TMS CLI

기존 Firebase Auth 계정으로 로그인해 에이전트가 독립 검색 서비스에 읽기 요청을 전달하는 CLI입니다. CLI는 Node.js 20 이상이 필요합니다.

독립 검색 서버에 연결하며, 관리자 필드 조회를 시험했습니다. 직원·협력사 운영 권한의 최종 검증과 검색 색인 동기화는 아직 진행 중입니다. 기존 Firebase 직접 조회 명령은 앱 권한과 Firebase 규칙의 차이 때문에 중단했습니다.

TMS 서비스는 **2026년 12월 31일 종료 예정**입니다. 새 데이터 쓰기는 금지되며, 기존 데이터 읽기는 종료 후 6개월간 제공될 예정입니다. 이 안내는 정책을 설명하며, 이 패키지 설치만으로 기존 앱이나 Firebase의 쓰기 권한 또는 서비스 종료를 자동 적용하지는 않습니다. 설치 과정의 안내가 표시되지 않으면 CLI 첫 실행 시 stderr에 표시하며 `tms notice`로 다시 볼 수 있습니다.

## 로그인과 검색

GitHub에 공개된 패키지는 GitHub 계정 없이 Node.js 20 이상에서 실행할 수 있습니다.

전역 설치를 권장합니다. GitHub 계정은 필요하지 않습니다.

```powershell
npm install --global @hs-jig/tms-cli
tms login
tms catalog
```

업데이트할 때도 같은 `npm install --global` 명령을 다시 실행하세요. 설치 후 `tms`를 찾지 못하면 터미널을 다시 열고 npm 전역 실행 경로가 PATH에 있는지 확인하세요.

설치 없이 한 번 실행하려면 `npx -y @hs-jig/tms-cli catalog`를 사용할 수 있습니다.

```powershell
tms login
tms whoami
tms catalog
tms plan                      # 에이전트가 작성한 JSON 계획을 표준 입력으로 전달
tms retrieve capabilities
'{"terms":[],"sources":["production-schedules"],"from":"2026-10-27","to":"2026-10-27"}' | tms retrieve
'{"terms":["구직각"],"order":"12345"}' | tms retrieve
'{"source":"jig-requests","filters":[{"field":"itemName","op":"prefix","value":"50G구직각"}],"limit":20}' | tms query
tms retrieve image --inspection 검사ID --index 1 --output ./quality.png
tms logout
```

## 에이전트가 조회 기준 추가하기

에이전트는 `tms catalog`에서 사용할 수 있는 자료와 필드를 확인하고 조건을 직접 조합할 수 있습니다. 반복해서 쓰는 조건이나 단계별 계획은 이 기기의 사용자별 저장소에 저장하고 변수만 바꿔 실행할 수 있습니다. 아래 예시는 품질이력에서 발주처·제품명·부속명을 함께 찾는 기준입니다.

```powershell
'{"kind":"query","request":{"source":"quality-inspections","filters":[{"field":"supplier","op":"eq","value":{"$param":"supplier"}},{"field":"productName","op":"eq","value":{"$param":"product"}},{"field":"partName","op":"eq","value":{"$param":"part"}}],"limit":20}}' | tms criteria save quality-jig
tms criteria list
tms criteria show quality-jig
'{"supplier":"발주처","product":"제품명","part":"부속명"}' | tms criteria run quality-jig
tms criteria remove quality-jig
```

`kind`는 단일 필드 조회인 `query` 또는 단계별 조회인 `plan`이며, `request`에 각각 `tms query` 또는 `tms plan` 요청을 넣습니다. `{"$param":"변수명"}`은 실행 시 표준 입력의 JSON 값으로 대체합니다. 이름과 변수명은 영문 소문자로 시작해야 합니다. 같은 이름은 덮어쓰지 않습니다. 조회 기준은 해당 기기와 사용자에 저장되며 다른 직원에게 자동 공유되지 않습니다. 비밀번호나 토큰을 기준에 넣지 마세요.

기준을 저장하는 것은 로컬 작업입니다. 실제 실행에는 로그인과 서버의 권한 검증이 필요하며, 각 실행에서 서버의 허용 자료·필드·행 권한 및 조회 한도가 그대로 적용됩니다. 에이전트가 조회 조건을 새로 추가하는 것과 서버에 아직 등록되지 않은 Firebase 컬렉션이나 필드를 여는 것은 다릅니다. 후자는 서버에서 별도 검토가 필요합니다.

자료 사전·필드 조회·조회 계획은 서버의 해당 사용자 권한에 따라 동작합니다. 부분 문자열용 검색 색인이 아직 준비되지 않아 `tms retrieve`와 `tms retrieve capabilities`는 현재 사용하지 못합니다. 이미지 조회는 권한에 따라 제한됩니다. 서버 주소는 패키지의 신뢰 목록으로 검증하며 임의의 주소에 사용자 토큰을 보내지 않습니다.

`login`은 로컬 브라우저에서 Firebase 이메일과 비밀번호로 로그인합니다. 비밀번호는 Firebase로 직접 전송되며 CLI에 전달하거나 저장하지 않습니다. 로그인 정보는 Windows 자격 증명 관리자, macOS 키체인 또는 Linux Secret Service에 저장합니다. `logout`은 이 기기의 저장 정보를 삭제합니다. MFA나 별도 인증 정책이 적용된 계정은 추가 구현이 필요할 수 있습니다.

## 에이전트 지침

`tms catalog`는 알려진 업무 자료, 필드 의미, 자료 간 연결 기준과 주의사항을 JSON으로 제공합니다. 수동으로 관리하는 자료 사전이므로 실제 DB의 모든 필드와 자료를 자동으로 반영하거나 색인 완료를 보장하지 않습니다. 서비스 검증·배포 후에 사용할 수 있습니다.

사용자는 자연어로 질문하고 에이전트가 날짜, 검색어, 발주번호와 필요한 업무 영역을 판단합니다. `tms retrieve capabilities`는 현재 색인된 업무 영역과 검색 필드를 JSON으로 반환합니다. `tms retrieve`는 JSON을 표준 입력으로 받고 결과를 JSON으로 반환합니다. `terms`의 모든 문자열을 부분 일치로 찾고, `order`는 발주번호 또는 모번호로 조회합니다. `from`과 `to`를 함께 지정해 날짜로 제한할 수 있습니다. `nextCursor`가 있으면 동일한 검색 조건과 커서를 전달합니다. 색인이 변경되거나 서비스가 재시작되면 이전 커서는 만료되며 처음부터 조회해야 합니다.

검색 결과는 `source`, 문서 ID, 날짜, 원본·색인 시각과 허용된 `details`를 포함합니다. `searchIncomplete`가 true이면 결과가 없더라도 실제 자료가 없다고 단정하지 않습니다. 여러 조건이 출고증 등 하나의 문서 안에서 서로 다른 행과 일치할 수 있으므로 반환된 행의 관계를 확인합니다. 품질 이미지가 있으면 문서 ID와 이미지 번호로 파일을 저장해 이미지 보기 도구에 전달합니다. 기존 파일은 덮어쓰지 않으며 이미지 URL의 다운로드 토큰은 출력하지 않습니다.

`tms query`는 별도 검색 색인 대신 허용된 자료와 필드에 `eq`, `in`, `array_any`, `lt`, `lte`, `gt`, `gte`, `prefix`, `prefix_any` 조건을 적용해 Firestore에서 직접 조회하는 시험 기능입니다. `prefix`는 저장된 문자열의 시작 부분이며 대소문자와 공백을 구분합니다. `prefix_any`는 최대 네 가지 접두어를 배열로 전달합니다. 원하는 결과가 중간 부분 일치나 다른 표기까지 포함해야 한다면 별도 검색 색인 또는 추가 질의가 필요합니다. 범위 조건은 한 필드에만 지정하며 결과 한도는 최대 50개입니다. `nextCursor`는 동일 사용자와 조건에만 사용할 수 있고 서버 재시작 또는 5분 후 만료됩니다. `possiblyMore`는 페이지가 꽉 찼다는 뜻으로 추가 결과의 존재를 보장하지 않습니다. `tms retrieve capabilities`의 `querySources`에서 사용 가능한 자료와 필드를 확인하세요.

관리자의 필드 쿼리는 실제 서버에서 시험했습니다. 일반 직원·협력사 정책은 규칙 전파와 계정별 검증이 끝나기 전까지 열리지 않을 수 있습니다. Firestore 쿼리에는 경우에 따라 복합 색인이 필요하고, 표시된 문서 수는 청구 읽기 수가 아닙니다.

## 보안과 운영

이 CLI는 쓰기 명령이 없지만, 그것만으로 Firebase 계정이 읽기 전용이 되는 것은 아닙니다. 사용자의 승인과 관리자 설정, 회사별 범위, 민감 필드 및 이미지 권한은 독립 서비스에서 강제해야 합니다. 운영 Firebase에는 현재 클라이언트 화면만으로 강제하는 권한이 있어 별도 보완이 필요합니다.

테스트용 `TMS_CLI_DIAGNOSTICS=1`은 HTTP 요청의 서비스 종류, 상태, 응답 헤더까지 걸린 시간을 stderr에 표시합니다. 검색어·URL·토큰·응답 데이터는 기록하지 않습니다. 응답 시간은 Firebase 청구 읽기 수가 아닙니다.

## 로컬 검증

```powershell
npm ci
npm test
npm pack --dry-run
```

공개 GitHub 저장소에 올리기 전, 실제 배포 주소와 안전한 권한 경계, 패키지 내용 및 이력의 비밀정보를 검토해야 합니다. 직원이 공개 저장소에서 설치할 때 GitHub 계정은 필요하지 않습니다.
