// 생성될 스프레드시트의 이름을 상수로 정의합니다.
const SPREADSHEET_NAME = "문제 생성 결과 시트";

/**
 * 웹 앱에 사용자가 처음 접속했을 때 (GET 요청) 실행되는 함수입니다.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle("문제 생성기 (v.1.3)")
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

/**
 * 사용자가 입력한 API 키를 해당 사용자의 속성으로 안전하게 저장합니다.
 */
function saveApiKey(apiKey) {
  try {
    const userProperties = PropertiesService.getUserProperties();
    userProperties.setProperty('LLM_API_KEY', apiKey);
    return { success: true, message: "API 키가 안전하게 저장되었습니다." };
  } catch (e) {
    throw new Error("API 키 저장 실패: " + e.message);
  }
}

/**
 * 현재 사용자의 속성에 저장된 API 키를 불러옵니다.
 */
function getApiKey() {
  const userProperties = PropertiesService.getUserProperties();
  return userProperties.getProperty('LLM_API_KEY');
}

/**
 * UserProperties에 저장된 API 키를 삭제합니다.
 */
function deleteApiKey() {
  try {
    const userProperties = PropertiesService.getUserProperties();
    userProperties.deleteProperty('LLM_API_KEY');
    return { success: true, message: "API 키가 성공적으로 삭제되었습니다." };
  } catch (e) {
    throw new Error("API 키를 삭제하는 중 오류가 발생했습니다: " + e.message);
  }
}

/**
 * PDF 처리의 메인 함수. 시트 저장 로직을 포함합니다.
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

    const apiKey = getApiKey();
    if (!apiKey) throw new Error("저장된 LLM API 키가 없습니다.");
    
    const htmlResult = callLlmApi(text, apiKey, fileData.numProblems);

    if (fileData.saveToSheet) {
      const sheet = getOrCreateSpreadsheet();
      saveProblemsToSheet(sheet, htmlResult);
    }
    
    return {
      htmlTable: htmlResult,
      didSaveToSheet: fileData.saveToSheet
    };

  } catch (e) {
    if (tempDocId) DriveApp.getFileById(tempDocId).setTrashed(true);
    Logger.log("오류 발생: " + e.toString());
    throw new Error("파일 처리 중 오류 발생: " + e.message);
  }
}

/**
 * "문제 생성 결과 시트"라는 이름의 스프레드시트를 찾거나, 없으면 새로 생성하여 시트 객체를 반환합니다.
 */
function getOrCreateSpreadsheet() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  let spreadsheet;
  if (files.hasNext()) {
    spreadsheet = SpreadsheetApp.openById(files.next().getId());
  } else {
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_NAME);
    const sheet = spreadsheet.getSheets()[0];
    sheet.appendRow(['생성 날짜', '문제 내용', '정답']);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 600);
    sheet.setColumnWidth(3, 100);
  }
  return spreadsheet.getSheets()[0];
}

/**
 * LLM이 생성한 HTML 테이블 문자열을 분석하여, 내용을 구글 시트에 저장합니다.
 */
function saveProblemsToSheet(sheet, htmlTable) {
  const regex = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
  let match;
  const rows = [];
  const now = new Date();
  while ((match = regex.exec(htmlTable)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    rows.push([now, question, answer]);
  }
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
}

/**
 * "문제 생성 결과 시트" 파일의 URL을 찾아 반환합니다.
 */
function getSheetUrl() {
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    return files.next().getUrl();
  } else {
    return "아직 시트가 생성되지 않았습니다. 먼저 문제를 한번 생성해주세요.";
  }
}

/**
 * 추출된 텍스트와 API 키로 LLM을 호출하는 함수
 */
function callLlmApi(text, apiKey, numProblems) {
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + apiKey;
    const prompt = `
      당신은 초등학교 교사를 위한 문제 출제 전문가입니다.
      다음 제시된 내용을 바탕으로, 초등학생 수준의 객관식 문제를 정확히 ${numProblems}개 만들어 주세요.
      **출력 형식 (매우 중요):**
      - 반드시 아래와 같은 HTML <table> 형식으로만 응답해야 합니다.
      - 각 문제와 정답은 각각 <tr> 태그로 감싸고, 문제(question)와 정답(answer)은 각각 <td> 태그 안에 넣어주세요.
      - 다른 설명이나 제목, 줄바꿈, markdown 등은 절대 추가하지 마세요.
      <table>
        <tr>
          <td>(여기에 첫 번째 문제의 내용을 모두 넣어주세요. 보기 포함)</td>
          <td>(여기에 첫 번째 문제의 정답을 넣어주세요)</td>
        </tr>
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
  } catch(e) {
    Logger.log("LLM API 호출 오류: " + e.toString());
    throw new Error("LLM API 호출 중 오류가 발생했습니다: " + e.message);
  }
}