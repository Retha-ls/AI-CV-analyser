// test-v4-tools.js - Test your actual tool schemas
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Copy your exact CV_EXTRACTION_TOOL from groqService.js
const CV_EXTRACTION_TOOL = {
  type: 'function',
  function: {
    name: 'submit_cv_structure',
    description: 'Submit structured data extracted from the CV.',
    parameters: {
      type: 'object',
      required: ['personalInfo', 'summary', 'experience', 'projects', 'education', 'skills', 'certifications', 'languages', 'cvQuality'],
      properties: {
        personalInfo: {
          type: 'object',
          properties: {
            name:      { type: 'string' },
            email:     { type: 'string' },
            phone:     { type: 'string' },
            location:  { type: 'string' },
            linkedin:  { type: 'string' },
            portfolio: { type: 'string' },
          },
        },
        summary: {
          type: 'object',
          required: ['text', 'wordCount', 'isTailored'],
          properties: {
            text:       { type: 'string' },
            wordCount:  { type: 'integer' },
            isTailored: { type: 'boolean' },
          },
        },
        experience: {
          type: 'array',
          description: 'Paid jobs and internships only — NOT personal projects.',
          items: {
            type: 'object',
            required: ['title', 'company', 'startYear', 'endYear', 'isCurrent', 'responsibilities', 'hasMetrics', 'yearsInRole'],
            properties: {
              title:            { type: 'string' },
              company:          { type: 'string' },
              startYear:        { type: 'integer' },
              endYear:          { type: 'integer' },
              isCurrent:        { type: 'boolean' },
              responsibilities: { type: 'array', items: { type: 'string' } },
              hasMetrics:       { type: 'boolean' },
              yearsInRole:      { type: 'number' },
            },
          },
        },
        projects: {
          type: 'array',
          description: 'Personal, academic, and freelance projects.',
          items: {
            type: 'object',
            required: ['name', 'description', 'technologiesUsed', 'isLive', 'hasMetrics', 'domain'],
            properties: {
              name:              { type: 'string' },
              description:       { type: 'string' },
              technologiesUsed:  { type: 'array', items: { type: 'string' } },
              isLive:            { type: 'boolean' },
              hasMetrics:        { type: 'boolean' },
              domain:            { type: 'string' },
            },
          },
        },
        education: {
          type: 'array',
          items: {
            type: 'object',
            required: ['degree', 'institution', 'field', 'year', 'isRelevant'],
            properties: {
              degree:      { type: 'string' },
              institution: { type: 'string' },
              field:       { type: 'string' },
              year:        { type: 'integer' },
              gpa:         { type: 'string' },
              isRelevant:  { type: 'boolean' },
            },
          },
        },
        skills: {
          type: 'object',
          required: ['technical', 'soft', 'tools', 'programmingLanguages'],
          properties: {
            technical:            { type: 'array', items: { type: 'string' } },
            soft:                 { type: 'array', items: { type: 'string' } },
            tools:                { type: 'array', items: { type: 'string' } },
            programmingLanguages: { type: 'array', items: { type: 'string' } },
          },
        },
        certifications: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'issuer', 'year'],
            properties: {
              name:   { type: 'string' },
              issuer: { type: 'string' },
              year:   { type: 'integer' },
            },
          },
        },
        languages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['language', 'proficiency'],
            properties: {
              language:    { type: 'string' },
              proficiency: { type: 'string' },
            },
          },
        },
        cvQuality: {
          type: 'object',
          required: ['totalWords', 'hasSummary', 'hasQuantifiedAchievements', 'hasPortfolioOrGithub', 'sectionsMissing', 'formattingIssues'],
          properties: {
            totalWords:                { type: 'integer' },
            hasSummary:                { type: 'boolean' },
            hasQuantifiedAchievements: { type: 'boolean' },
            hasPortfolioOrGithub:      { type: 'boolean' },
            sectionsMissing:           { type: 'array', items: { type: 'string' } },
            formattingIssues:          { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

async function testCVExtraction() {
  console.log('Testing CV Extraction Tool with a simple CV...\n');
  
  const testCV = `
Rethabile Matela
Software Developer Intern at LocalBites
Education: National University of Lesotho, CS degree 2026
Skills: Python, JavaScript, PHP, MySQL
Project: Budget Bridge - financial management system
  `;
  
  try {
    console.log('Calling Groq API with CV_EXTRACTION_TOOL...');
    
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ 
        role: 'user', 
        content: `Extract structured data from this CV. Use the submit_cv_structure tool.

CV:
${testCV}`
      }],
      temperature: 0.0,
      max_tokens: 2000,
      tools: [CV_EXTRACTION_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_cv_structure' } },
    });
    
    console.log('✅ API call successful!');
    console.log('Response choice type:', response.choices[0].finish_reason);
    
    const message = response.choices[0].message;
    console.log('Has tool_calls:', !!message.tool_calls);
    
    if (message.tool_calls && message.tool_calls[0]) {
      console.log('Tool call name:', message.tool_calls[0].function.name);
      console.log('Arguments length:', message.tool_calls[0].function.arguments.length);
      
      // Try to parse the JSON
      try {
        const parsed = JSON.parse(message.tool_calls[0].function.arguments);
        console.log('✅ JSON parsed successfully!');
        console.log('Extracted name:', parsed.personalInfo?.name);
        console.log('Projects count:', parsed.projects?.length);
      } catch (parseErr) {
        console.error('❌ JSON parse error:', parseErr.message);
        console.log('First 200 chars of arguments:', message.tool_calls[0].function.arguments.substring(0, 200));
      }
    } else if (message.content) {
      console.log('Model returned text instead of tool call:');
      console.log(message.content.substring(0, 500));
    }
    
  } catch (err) {
    console.error('❌ API call failed!');
    console.error('Error message:', err.message);
    if (err.status) console.error('Status:', err.status);
    if (err.response?.data) console.error('Response data:', JSON.stringify(err.response.data, null, 2));
  }
}

async function testScoringTool() {
  console.log('\n--- Testing SCORING_TOOL ---\n');
  
  const SCORING_TOOL = {
    type: 'function',
    function: {
      name: 'submit_cv_scoring',
      parameters: {
        type: 'object',
        required: ['keywordMatch', 'sections', 'suggestions', 'recruiterVerdict', 'hiringRecommendation'],
        properties: {
          keywordMatch: {
            type: 'object',
            properties: {
              found: { type: 'array', items: { type: 'string' } },
              missing: { type: 'array', items: { type: 'string' } }
            }
          },
          sections: {
            type: 'object',
            properties: {
              experience: { type: 'object', properties: { score: { type: 'integer' }, feedback: { type: 'string' } } },
              skills: { type: 'object', properties: { score: { type: 'integer' }, feedback: { type: 'string' } } },
              education: { type: 'object', properties: { score: { type: 'integer' }, feedback: { type: 'string' } } },
              summary: { type: 'object', properties: { score: { type: 'integer' }, feedback: { type: 'string' } } }
            }
          },
          suggestions: { type: 'array', items: { type: 'string' } },
          recruiterVerdict: { type: 'string' },
          hiringRecommendation: { type: 'string', enum: ['strong_yes', 'yes', 'maybe', 'no', 'strong_no'] }
        }
      }
    }
  };
  
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ 
        role: 'user', 
        content: 'Score this CV against the job description. Use submit_cv_scoring tool.' 
      }],
      tools: [SCORING_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_cv_scoring' } },
    });
    
    console.log('✅ Scoring tool test passed!');
  } catch (err) {
    console.error('❌ Scoring tool test failed:', err.message);
  }
}

// Run tests
async function main() {
  await testCVExtraction();
  await testScoringTool();
}

main();