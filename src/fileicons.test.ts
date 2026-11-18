import { assert, test } from 'orca/testing'
import { fileIcon, fileType } from '../panel/fileicons.js'

test('file types: by name, by extension, tests and unknown files', () => {
  assert.equal(fileType('src/core/ui/ConfirmDialog.tsx'), 'tsx')
  assert.equal(fileType('src/core/i18n/locales/es.json'), 'json')
  assert.equal(fileType('src/modules/x/TemplatesPage.test.tsx'), 'test')
  assert.equal(fileType('.gitignore'), 'git')
  assert.equal(fileType('package-lock.json'), 'lock')
  assert.equal(fileType('.env.local'), 'env')
  assert.equal(fileType('docs/README.MD'), 'md')
  assert.equal(fileType('LICENSE'), null)
  assert.match(fileIcon('a.ts'), /<rect[^>]*fill="#3178c6"/)
  assert.match(fileIcon('LICENSE'), /stroke="currentColor"/)
})
