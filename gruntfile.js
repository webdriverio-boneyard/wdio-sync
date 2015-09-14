module.exports = function(grunt) {
    grunt.initConfig({
        pkgFile: 'package.json',
        clean: ['build'],
        babel: {
            options: {
                sourceMap: false
            },
            dist: {
                src: 'index.js',
                dest: 'build/index.js'
            }
        },
        eslint: {
            options: {
                parser: 'babel-eslint'
            },
            target: ['index.js']
        },
        contributors: {
            options: {
                commitMessage: 'update contributors'
            }
        },
        bump: {
            options: {
                commitMessage: 'v%VERSION%',
                pushTo: 'upstream'
            }
        }
    });

    require('load-grunt-tasks')(grunt);
    grunt.registerTask('default', ['build']);
    grunt.registerTask('build', 'Build wdio-mocha', function() {
        grunt.task.run([
            'jshint',
            'eslint',
            'clean',
            'babel'
        ]);
    });
    grunt.registerTask('release', 'Bump and tag version', function(type) {
        grunt.task.run([
            'build',
            'contributors',
            'bump:' + (type || 'patch')
        ]);
    });
};
