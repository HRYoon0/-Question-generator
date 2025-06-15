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
    // '수준' 컬럼 헤더 추가
    sheet.appendRow(['생성 날짜', '문제 내용', '정답', '출처 파일', '수준']);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 600);
    sheet.setColumnWidth(3, 100);
    sheet.setColumnWidth(4, 200);
    sheet.setColumnWidth(5, 80);
  }
  return spreadsheet.getSheets()[0];
}

/**
 * LLM이 생성한 HTML 테이블 문자열을 분석하여, 내용을 구글 시트에 저장합니다.
 */
function saveProblemsToSheet(sheet, htmlTable, pdfFileName, level) {
  const regex = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
  let match;
  const rows = [];
  const now = new Date();
  while ((match = regex.exec(htmlTable)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    // 수준 정보를 마지막 열에 추가
    rows.push([now, question, answer, pdfFileName, level]);
  }
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/**
 * PDF 처리의 메인 함수.
 */
function processPdfAndGenerateProblems(fileData) {
  let tempDocId = null;
  let savedSheetName = null;
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(fileData.fileBytes), fileData.mimeType, fileData.fileName);
    const resource = { title: fileData.fileName, mimeType: 'application/vnd.google-apps.document' };
    const tempDoc = Drive.Files.insert(resource, blob, {convert: true});
    tempDocId = tempDoc.id;
    const text = DocumentApp.openById(tempDocId).getBody().getText();
    DriveApp.getFileById(tempDocId).setTrashed(true);

    if (text.trim().length < 20) throw new Error("PDF에서 충분한 텍스트를 추출하지 못했습니다.");
    
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("저장된 LLM API 키가 없습니다.");
    
    // callLlmApi 호출 시 두 종류의 문제 개수를 모두 전달합니다.
    const htmlResult = callLlmApi(text, apiKey, fileData.numMultipleChoice, fileData.numShortAnswer, fileData.level);

    if (fileData.saveToSheet) {
      const targetSheet = getOrCreateSpreadsheet();
      // 시트 저장 시에도 수준(level) 정보를 함께 전달합니다.
      saveProblemsToSheet(targetSheet, htmlResult, fileData.fileName, fileData.level);
      savedSheetName = targetSheet.getParent().getName();
    }
    
    return {
      htmlTable: htmlResult,
      didSaveToSheet: fileData.saveToSheet,
      sheetName: savedSheetName
    };
  } catch (e) {
    if (tempDocId) DriveApp.getFileById(tempDocId).setTrashed(true);
    throw new Error("파일 처리 중 오류 발생: " + e.message);
  }
}

/**
 * "문제 생성 결과 시트" 파일의 URL을 찾아 반환합니다.
 */
function getSheetUrl() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) { return files.next().getUrl(); } 
  else { return "아직 시트가 생성되지 않았습니다. 먼저 문제를 한번 생성해주세요."; }
}

/**
 * 사용자의 API 키를 저장합니다.
 */
function saveApiKey(apiKey) {
  try { PropertiesService.getUserProperties().setProperty('LLM_API_KEY', apiKey); return { success: true, message: "API 키가 안전하게 저장되었습니다." }; } 
  catch (e) { throw new Error("API 키 저장 실패: " + e.message); }
}

/**
 * 저장된 API 키를 불러옵니다.
 */
function getApiKey() {
  return PropertiesService.getUserProperties().getProperty('LLM_API_KEY');
}

/**
 * 저장된 API 키를 삭제합니다.
 */
function deleteApiKey() {
  try { PropertiesService.getUserProperties().deleteProperty('LLM_API_KEY'); return { success: true, message: "API 키가 성공적으로 삭제되었습니다." }; } 
  catch (e) { throw new Error("API 키를 삭제하는 중 오류가 발생했습니다: " + e.message); }
}

/**
 * LLM API를 호출하는 함수. 객관식/단답형 개수에 따라 프롬프트를 동적으로 변경합니다.
 */
function callLlmApi(text, apiKey, numMultipleChoice, numShortAnswer, level) {
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + apiKey;
    
    let levelDescription = "초등학생";
    if (level === "중등") { levelDescription = "중학생"; } 
    else if (level === "고등") { levelDescription = "고등학생"; }

    const prompt = `
      당신은 교사를 위한 문제 출제 전문가입니다.
      다음 제시된 내용을 바탕으로, '${levelDescription}' 수준의 문제를 아래 조건에 맞게 만들어 주세요.

      [생성 조건]
      1. 객관식 문제: 정확히 ${numMultipleChoice}개
      2. 단답형 문제: 정확히 ${numShortAnswer}개
      3. 문제 순서: 객관식 문제를 먼저 모두 생성한 후, 단답형 문제를 생성해주세요.

      [출력 형식 (매우 중요)]
      - 반드시 아래와 같은 HTML <table> 형식으로만 응답해야 합니다.
      - 각 문제와 정답은 각각 <tr> 태그로 감싸고, 문제(question)와 정답(answer)은 각각 <td> 태그 안에 넣어주세요.
      - 문제 내용 앞에 [객관식] 또는 [단답형]과 같이 유형을 반드시 표시해주세요.
      - 다른 설명이나 제목, 줄바꿈, markdown 등은 절대 추가하지 마세요.

      <table>
        <tr><td>[객관식] 문제 예시...</td><td>(정답 예시)</td></tr>
        <tr><td>[단답형] 문제 예시...</td><td>(정답 예시)</td></tr>
      </table>

      --- 제시된 내용 ---
      ${text.substring(0, 8000)}
    `;
    
    const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };
    const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload), 'muteHttpExceptions': true };
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    if (result.error) { throw new Error(result.error.message); }
    if (result.candidates && result.candidates.length > 0) { return result.candidates[0].content.parts[0].text; } 
    else { throw new Error("API에서 유효한 응답을 받지 못했습니다."); }
  } catch(e) { throw new Error("LLM API 호출 중 오류가 발생했습니다: " + e.message); }
}
