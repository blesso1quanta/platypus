// =============================================================================
// Project Platypus
// =============================================================================

import { Request } from 'express'
import { customAlphabet } from 'nanoid/non-secure'

import { MathigonStudioApp } from '@mathigon/studio/server/app'
import { getCourse, loadJSON } from '@mathigon/studio/server/utilities/utilities'
import { Progress } from '@mathigon/studio/server/models/progress'
import { CourseAnalytics } from '@mathigon/studio/server/models/analytics'
import { LOCALES, translate } from '@mathigon/studio/server/utilities/i18n'

import {
  CONFIG, NOTATIONS, TEXTBOOK_HOME, TRANSLATIONS, UNIVERSAL_NOTATIONS,
  findNextSection, findPrevSection, getSectionIndex, isLearningPath,
  updateGlossary, loadLocaleRawFile, tocFilterByType
} from './utilities'
import { TocCourse } from './interfaces'

const DEFAULT_PRIVACY_POLICY_PATH = '/translations/privacy-policy.md'

const getCourseData = async function (req: Request) {
  const course = getCourse(req.params.course, req.locale.id)
  const section = course?.sections.find(s => s.id === req.params.section)

  if (!course || !section) { return null }

  const lang = course.locale || 'en'
  const learningPath = isLearningPath(course)

  const response = await Progress.lookup(req, course.id)
  const progressJSON = JSON.stringify({
    [course.id]: {
      [section.id]: JSON.parse(response?.getJSON(section.id) || '{}')
    }
  })
  const notationsJSON = JSON.stringify(NOTATIONS[lang] || {})
  const universalJSON = JSON.stringify(UNIVERSAL_NOTATIONS[lang] || {})
  const translationsJSON = JSON.stringify(TRANSLATIONS[lang] || {})

  course.glossJSON = updateGlossary(course)

  const nextSection = findNextSection(course, section)
  const prevSection = findPrevSection(course, section)
  const subsections = getSectionIndex(course, section)

  if (req.user) {
    CourseAnalytics.track(req.user.id) // async
  }

  return {
    course,
    section,
    config: CONFIG,
    progressJSON,
    progressData: response,
    notationsJSON,
    learningPath,
    nextSection,
    prevSection,
    universalJSON,
    translationsJSON,
    subsections,
    textbookHome: TEXTBOOK_HOME,
    // override `__()`  to pass in the course locale instead of default req locale
    __: (str: string, ...args: string[]) => translate(lang, str, args)
  }
}

const getUserProgressData = async (userId: string) => {
  let progress = {}
  const courses = await Progress.find({ userId }).exec()

  for (const course of courses) {
    const courseContent = loadJSON(`public/content/${course.courseId}/data_en.json`) as any
    const sections: { [key: string]: any } = {}

    for (const [key, value] of course.sections) {
      const sectrionFromCourseContent = courseContent.sections.find((section: any) => section.id === key)
      const { steps } = sectrionFromCourseContent

      sections[key] = {
        progress: value.progress,
        steps: {}
      }

      for (const step of steps) {
        sections[key].steps[step] = course.steps.get(step)?.scores
      }
    }

    progress = {
      ...progress,
      [course.courseId]: sections
    }
  }

  return progress
}

new MathigonStudioApp()
  .get('/health', (req, res) => res.status(200).send('ok')) // Server Health Checks
  .secure()
  .setup({ sessionSecret: 'project-platypus-beta' })
  // .redirects({'/login': '/signin'})
  .accounts()
  .redirects({
    '/': TEXTBOOK_HOME,
    '/textbook': TEXTBOOK_HOME
  })
  .get('/locales/:locale', async (req, res) => {
    const translations = TRANSLATIONS[req.params.locale || 'en'] || {}
    res.json(translations)
  })
  .use(async (req, res, next) => {
    res.locals.availableLocales = CONFIG.locales.map((l) => {
      return LOCALES[l]
    })
    next()
  })
  .get('/courseList', async (req, res) => {
    res.json(tocFilterByType())
  })
  .get('/courseList/:type', async (req, res) => {
    let type = req.params.type || ''
    if (type === 'none') {
      type = ''
    }
    const courses: TocCourse[] = tocFilterByType(type)
    res.json(courses)
  })
  .get('/delete/account', async (req, res) => {
    if (!req.user) return {error: 'unauthenticated', errorCode: 401, redirect: '/signin'}

    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    // 21 value is to maintain the probability collision similar to UUIDv4
    const nanoid = customAlphabet(alphabet, 21)
    const randomString = nanoid()
    req.user.email = `deleted-${randomString}@qiskit.org`
    req.user.firstName = randomString
    req.user.lastName = randomString
    req.user.picture = ''
    req.user.oAuthTokens = [
      `qiskit:${randomString}`
    ]

    try {
      await req.user.save()
    } catch(error) {
      // TODO: we must improve our logs
      console.error(error)
    }

    res.redirect('/logout')
  })
  .get('/account', async (req, res) => {
    if (!req.user) return res.redirect('/signin');
    if (req.user && !req.user.acceptedPolicies) return res.redirect('/eula');

    const lang = req.locale.id || 'en'
    const translationsJSON = JSON.stringify(TRANSLATIONS[lang] || {})

    const privacyPolicyMD = loadLocaleRawFile('privacy-policy.md', lang)

    const userMockData = {
      firstName: req.user?.firstName,
      lastName: req.user?.lastName
    }

    const progressData = await getUserProgressData(req.user.id)

    res.render('userAccount', {
      config: CONFIG,
      userData: userMockData,
      progressJSON: JSON.stringify(progressData),
      lang,
      privacyPolicyMD,
      translationsJSON
    })
  })
  .get('/eula', (req, res) => {
    if (!req.user) return res.redirect('/signin');

    const lang = req.locale.id || 'en'
    const translationsJSON = JSON.stringify(TRANSLATIONS[lang] || {})

    const privacyPolicyMD = loadLocaleRawFile('privacy-policy.md', lang)

    res.render('eula', {
      config: CONFIG,
      lang,
      privacyPolicyMD,
      translationsJSON
    })
  })
  .get('/summer-school/:course', (req, res, next) => {
    // redirect to first lecture when no lecture specified
    const course = getCourse(req.params.course, req.locale.id)
    return course ? res.redirect(`/summer-school/${course.id}/${course.sections[0].id}`) : next();
  })
  .get('/summer-school/:course/:section', async(req, res, next) => {
    // example URL: /summer-school/2021/lec1-2
    // :course - refers to the summer school year
    // :section - refers to the lecture id
    const courseData = await getCourseData(req)

    courseData?.course.sections.forEach(section => {
      // Mathigon by default set url as 'course/'
      section.url = section.url.replace('course/', 'summer-school/')
    })

    if (!courseData) {
      return next()
    } else {
      res.render('textbook', courseData)
    }
  })
  .get('/course/:course/:section', async (req, res, next) => {
    const courseData = await getCourseData(req)

    if (!courseData) {
      return next()
    } else {
      res.render('textbook', courseData)
    }
  })
  .get('/signin', async (req, res) => {
    if (req.user && req.user.acceptedPolicies) return res.redirect('/account');

    const lang = req.locale.id || 'en'
    const translationsJSON = JSON.stringify(TRANSLATIONS[lang] || {})

    res.render('signIn', {
      textbookHome: TEXTBOOK_HOME,
      config: CONFIG,
      lang,
      translationsJSON
    })
  })
  .course({})
  .errors()
  .listen()
