// 생성될 스프레드시트의 이름을 상수로 정의합니다.
const SPREADSHEET_NAME = "문제 생성 결과 시트";

/**
 * 웹 앱에 사용자가 처음 접속했을 때 (GET 요청) 실행되는 함수입니다.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle("AI 문제 생성기")
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

/**
 * "문제 생성 결과 시트"라는 이름의 마스터 스프레드시트를 찾거나, 없으면 새로 생성하여 시트 객체를 반환합니다.
 */
function getOrCreateSpreadsheet() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  let spreadsheet;
  if (files.hasNext()) {
    spreadsheet = SpreadsheetApp.openById(files.next().getId());
  } else {
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_NAME);
    const sheet = spreadsheet.getSheets()[0];
    sheet.appendRow(['생성 날짜', '출처', '수준', '지문', '문제 유형', '문제 내용', '정답']);
    sheet.setColumnWidth(1, 150); sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(3, 80); sheet.setColumnWidth(4, 400);
    sheet.setColumnWidth(5, 100); sheet.setColumnWidth(6, 400);
    sheet.setColumnWidth(7, 100);
  }
  return spreadsheet.getSheets()[0];
}

/**
 * [수정됨] LLM이 생성한 JSON 데이터를 분석하여, 내용을 구글 시트에 저장합니다.
 */
function saveProblemsToSheet(sheet, problemData, sourceName, level) {
  const now = new Date();
  const rows = problemData.flatMap(set => {
    const passage = set.passage;
    return set.questions.map(q => {
      let fullQuestion = `${q.question}`;
      // 객관식 문제일 경우, 선택지를 줄바꿈으로 추가합니다.
      if (q.type === '객관식' && q.options) {
        const numberedOptions = q.options.map((opt, i) => `①②③④⑤`[i] + ` ` + opt);
        fullQuestion += '\n' + numberedOptions.join('\n');
      }

      // 정답 텍스트를 가공합니다.
      let answerText = q.answer;
      // 문제가 객관식이고 options 배열이 있을 경우
      if (q.type === '객관식' && q.options && Array.isArray(q.options)) {
        // 정답과 일치하는 선택지의 인덱스를 찾습니다.
        const answerIndex = q.options.findIndex(opt => opt.trim() === q.answer.trim());
        // 일치하는 선택지를 찾았을 경우
        if (answerIndex !== -1) {
          const choiceNumber = ['①', '②', '③', '④', '⑤'][answerIndex];
          // 정답 텍스트 앞에 선다형 번호를 추가합니다.
          answerText = `${choiceNumber} ${q.answer}`;
        }
      }
      // 최종적으로 시트에 저장될 행 데이터를 반환합니다.
      return [now, sourceName, level, passage, q.type, fullQuestion, answerText];
    });
  });
  // 데이터가 있을 경우에만 시트에 추가합니다.
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/**
 * PDF 파일로부터 텍스트를 추출하여 문제 생성 공통 로직을 호출합니다.
 */
function processPdfAndGenerateProblems(fileData) {
  let tempDocId = null;
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(fileData.fileBytes), fileData.mimeType, fileData.fileName);
    const resource = { title: fileData.fileName, mimeType: 'application/vnd.google-apps.document' };
    const tempDoc = Drive.Files.insert(resource, blob, {convert: true});
    tempDocId = tempDoc.id;
    const text = DocumentApp.openById(tempDocId).getBody().getText();
    DriveApp.getFileById(tempDocId).setTrashed(true);
    if (text.trim().length < 20) throw new Error("PDF에서 충분한 텍스트를 추출하지 못했습니다.");
    
    return generateProblemsFromText({ ...fileData, text: text, sourceName: fileData.fileName });

  } catch (e) {
    if (tempDocId) DriveApp.getFileById(tempDocId).setTrashed(true);
    throw new Error("파일 처리 중 오류 발생: " + e.message);
  }
}

/**
 * 텍스트를 기반으로 문제를 생성하는 공통 로직 함수입니다.
 */
function generateProblemsFromText(data) {
  let savedSheetName = null;
  try {
    const text = data.text;
    if (!text || text.trim().length < 20) {
      throw new Error("분석할 텍스트가 너무 짧습니다.");
    }
    
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("저장된 LLM API 키가 없습니다.");
    
    const llmResponse = callLlmApi(text, apiKey, data.numMultipleChoice, data.numShortAnswer, data.level, data.subject);
    
    const cleanedResponse = llmResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const resultObject = JSON.parse(cleanedResponse);

    if (data.saveToSheet) {
      const targetSheet = getOrCreateSpreadsheet();
      const sourceName = data.sourceName || "붙여넣은 텍스트";
      saveProblemsToSheet(targetSheet, resultObject, sourceName, data.level);
      savedSheetName = targetSheet.getParent().getName();
    }
    
    return {
      problemData: resultObject,
      didSaveToSheet: data.saveToSheet,
      sheetName: savedSheetName
    };
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error("AI가 형식에 맞지 않는 답변을 생성했습니다. 다른 내용으로 다시 시도해주세요.");
    }
    throw new Error("문제 생성 중 오류 발생: " + e.message);
  }
}

/**
 * LLM API를 호출하는 함수. '계획 후 실행' 프롬프트와 과목별 세부 규칙을 모두 적용했습니다.
 */
function callLlmApi(text, apiKey, numMultipleChoice, numShortAnswer, level, subject) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + apiKey;
  let levelDescription = "초등학생";
  if (level === "중등") { levelDescription = "중학생"; } 
  else if (level === "고등") { levelDescription = "고등학생"; }

  let prompt;
  
  const totalProblems = parseInt(numMultipleChoice) + parseInt(numShortAnswer);
  const numPassageProblems = Math.round(totalProblems * 0.8);
  const numStandaloneProblems = totalProblems - numPassageProblems;

  if (subject === '국어') {
    prompt = `
      당신은 국어 교사를 위한 최고의 문제 출제 AI입니다.
      [최우선 원칙]
      1. **정확한 개수 생성**: 당신의 가장 중요한 임무는 요청된 문제 개수(객관식 ${numMultipleChoice}개, 단답형 ${numShortAnswer}개)를 반드시, 무슨 일이 있어도 정확하게 지켜서 생성하는 것입니다.
      2. **객관식 선지 5개**: 모든 객관식 문제는 반드시 5개의 선택지를 포함해야 합니다.

      [작업 절차]
      1. **계획 수립**: 먼저, 총 ${totalProblems}개의 문제를 어떻게 구성할지 계획합니다. 이 중 ${numPassageProblems}개는 '지문 독해 문제'로, ${numStandaloneProblems}개는 '독립형 문제'로 배정합니다.
      2. **문제 생성**: 계획에 따라 문제를 생성합니다.
         - **지문 독해 문제**: 주어진 텍스트에서 다양한 지문을 선택하여, 내용을 재구성한 새로운 문제를 만듭니다.
         - **독립형 문제**: 지문 없이 핵심 어휘나 개념을 묻는 문제를 생성하되, 이 문제들은 반드시 '객관식' 유형이어야 합니다.
      3. **최종 검토**: JSON을 생성하기 전에, 당신이 만든 문제들의 총 개수와 유형별 개수가 요청된 것과 정확히 일치하는지 스스로 검토하고 확인하십시오.
      4. **JSON 출력**: 최종 검토 후, 아래 [출력 형식]에 맞춰 유효한 단일 JSON 배열(Array) 형식으로만 응답하십시오.

      [출력 형식]
      - 각 배열 요소는 'passage'(독립형 문제는 빈 문자열 "")와 'questions'(array of objects) 키를 가진 객체입니다.
      - 각 question 객체는 'type', 'question', 'options'(객관식일 경우 5개 string array), 'answer'(string) 키를 가집니다.
      ---
      [사용자가 제공한 텍스트]:
      ${text.substring(0, 8000)}
    `;
  } else { // 수학/기타
    prompt = `
      당신은 수학 및 기타 과목을 위한 최고의 문제 출제 AI입니다.
      [최우선 원칙]
      1. **정확한 개수 생성**: 당신의 가장 중요한 임무는 요청된 문제 개수(객관식 ${numMultipleChoice}개, 단답형 ${numShortAnswer}개)를 반드시, 무슨 일이 있어도 정확하게 지켜서 생성하는 것입니다.
      2. **객관식 선지 5개**: 모든 객관식 문제는 반드시 5개의 선택지를 포함해야 합니다.

      [작업 절차]
      1. **계획 수립**: 먼저, 생성할 총 ${totalProblems}개의 문제에 대한 계획을 세웁니다.
      2. **문제 생성**: 계획에 따라, 주어진 샘플 문제나 개념을 바탕으로 유사한 유형의 새로운 응용 문제를 생성합니다.
         - **지문 판단**: 샘플 문제 자체가 "다음 글을 읽고" 와 같이 명확한 지문을 포함하고 있을 경우에만, 그 구조를 반영하여 새로운 지문과 문제를 만드십시오. 그 외에는 절대 지문을 만들지 마십시오.
         - **유사 유형 변형**: 숫자, 조건 등은 바꾸되, 핵심 원리는 동일한 문제를 생성하십시오.
         - **단답형 유형**: 단답형 문제는 숫자나 한 단어로 답할 수 있는 간단한 질문 위주로 생성하십시오.
      3. **최종 검토**: JSON을 생성하기 전에, 당신이 만든 문제들의 총 개수와 유형별 개수가 요청된 것과 정확히 일치하는지 스스로 검토하고 확인하십시오.
      4. **JSON 출력**: 최종 검토 후, 아래 [출력 형식]에 맞춰 유효한 단일 JSON 배열(Array) 형식으로만 응답하십시오.
      
      [출력 형식]
      - 각 배열 요소는 'passage' (필요한 경우에만 내용 포함, 아니면 빈 문자열 "")와 'questions'(문제가 1개만 담긴 array) 키를 가집니다.
      - 각 question 객체는 'type', 'question', 'options'(객관식일 경우 5개 string array), 'answer'(string) 키를 가집니다.
      ---
      [사용자가 제공한 텍스트]:
      ${text.substring(0, 8000)}
    `;
  }
    
  const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload), 'muteHttpExceptions': true };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    if (result.error) { throw new Error(result.error.message); }
    if (result.candidates && result.candidates.length > 0) { return result.candidates[0].content.parts[0].text; } 
    else { throw new Error("API에서 유효한 응답을 받지 못했습니다."); }
  } catch(e) { throw new Error("LLM API 호출 중 오류가 발생했습니다: " + e.message); }
}

function getSheetUrl() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  return files.hasNext() ? files.next().getUrl() : "아직 시트가 생성되지 않았습니다.";
}
function saveApiKey(apiKey) {
  try { PropertiesService.getUserProperties().setProperty('LLM_API_KEY', apiKey); return { success: true }; } 
  catch (e) { throw new Error("API 키 저장 실패: " + e.message); }
}
function getApiKey() {
  return PropertiesService.getUserProperties().getProperty('LLM_API_KEY');
}
function deleteApiKey() {
  try { PropertiesService.getUserProperties().deleteProperty('LLM_API_KEY'); return { success: true }; } 
  catch (e) { throw new Error("API 키를 삭제하는 중 오류가 발생했습니다: " + e.message); }
}
